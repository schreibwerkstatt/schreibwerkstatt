'use strict';
// Autorenprofil-Deutung: verdichtet die BUCH-Stilprofile und die gemessenen
// Kennzahlen zu einer Aussage ueber den Autor.
//
// Der einzige Job der App OHNE Buchbezug (`bookId = 0`, Dedup ueber die
// E-Mail) — das Ergebnis gehoert dem Konto, nicht einem Werk. Praezedenz fuer
// die Null-Buch-ID ist `book-import`.
//
// Er liest KEINEN Buchtext: `book_settings.stilprofil` haelt je Buch bereits das
// Destillat (Job `stilprofil`), und die Zahlen kommen aus lib/author-profile.js.
// Ein Volltext-Pass ueber mehrere lange Romane passt in kein Kontextfenster, ein
// Pass ueber deren Profiltexte in jedes.

const express = require('express');
const contentStore = require('../../lib/content-store');
const { getBookSettings } = require('../../db/schema');
const { getAuthorProfile, saveAuthorProfileRun } = require('../../db/author-profile');
const { renderAuthorProfileMeasurement } = require('../../lib/author-profile');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts,
  tps, createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { sessionEmail } = require('../../lib/acl');
const logger = require('../../logger');

const autorenprofilRouter = express.Router();

/**
 * Locale des Laufs. Sie kommt aus dem ZULETZT gemessenen eigenen Buch, nicht aus
 * den Buch-Einstellungen irgendeines Buchs und nicht aus der UI-Sprache: das
 * Profil beschreibt Prosa, und deren Sprache steht am Werk. Buchtyp und
 * Buch-Kontext bleiben bewusst aussen vor — ein werk-uebergreifendes Profil darf
 * nicht die Gattungsregeln eines einzelnen Buchs erben.
 */
function _localeFor(books, userEmail) {
  const newest = books.length ? books[books.length - 1] : null;
  if (!newest) return 'de-CH';
  try {
    const st = getBookSettings(newest.book_id, userEmail);
    if (st?.language) return `${st.language}-${st.region || 'CH'}`;
  } catch { /* Settings fehlen → Default */ }
  return 'de-CH';
}

async function runAutorenprofilJob(jobId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    log.info(`Start: Autorenprofil ${userEmail}`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 5 });

    const measurement = getAuthorProfile(userEmail);
    // Ohne gemessenes Buch gibt es nichts zu deuten. Kein Fehler — die Karte
    // zeigt denselben Leerzustand wie ohne Lauf und sagt, was fehlt.
    if (!measurement.counts.measured) { completeJob(jobId, { empty: true }); return; }

    // Buchnamen ueber die Content-Store-Facade (nie per SQL auf `books`).
    // Die Facade mappt `books.book_id` auf `id` — nicht `book_id` erwarten.
    const all = await contentStore.listBooks(null);
    const nameById = Object.fromEntries(
      (all || []).filter(b => b && b.id != null).map(b => [b.id, b.name])
    );

    updateJob(jobId, { statusText: 'job.phase.collectingProfiles', progress: 20 });
    // Die Buch-Stilprofile sind die Textgrundlage. Fehlende werden uebersprungen,
    // nicht ersetzt: ein Buch ohne Stilprofil traegt eben nur seine Zahlen bei.
    const profile = [];
    for (const b of measurement.books) {
      let stp = '';
      try { stp = (getBookSettings(b.book_id, userEmail)?.stilprofil || '').trim(); } catch { stp = ''; }
      if (stp) profile.push({ titel: nameById[b.book_id] || `Buch ${b.book_id}`, stilprofil: stp });
    }

    const prompts = await getPrompts(userEmail);
    const { buildAutorenprofilPrompt, SCHEMA_AUTORENPROFIL, AUTORENPROFIL_METRIC_LABELS,
            AUTORENPROFIL_LANGUAGE_LABELS, getLocalePromptsForBook } = prompts;
    const { SYSTEM_AUTORENPROFIL } = getLocalePromptsForBook(
      _localeFor(measurement.books, userEmail), null, null, false, null, null, false,
    );

    const messung = renderAuthorProfileMeasurement(measurement, {
      nameById, labels: AUTORENPROFIL_METRIC_LABELS, languageNames: AUTORENPROFIL_LANGUAGE_LABELS,
    });

    updateJob(jobId, { statusText: 'job.phase.distillingStyle', progress: 35 });
    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildAutorenprofilPrompt({
        messung, profile, buecher: measurement.counts.measured,
        mehrsprachig: measurement.multiLanguage,
        entwicklungMoeglich: measurement.developmentAvailable,
      }),
      SYSTEM_AUTORENPROFIL,
      35, 97, 2500, 0.3, null, undefined, SCHEMA_AUTORENPROFIL,
    );

    const profilText = (result?.autorenprofil || '').trim();
    if (!profilText) throw i18nError('job.error.autorenprofilMissing');

    // Entwicklung ohne zwei Buecher DERSELBEN Sprache verwerfen, auch wenn das
    // Modell welche liefert: sie waere per Konstruktion unbelegt (ein Buch) oder ein
    // Sprachunterschied (je Sprache ein Buch). Der Prompt verbietet es, der Server
    // erzwingt es — dieselbe Arbeitsteilung wie bei der Belegzitat-Verifikation der
    // Buchbewertung.
    const entwicklung = measurement.developmentAvailable && Array.isArray(result.entwicklung)
      ? result.entwicklung : [];
    const konstanten = Array.isArray(result.konstanten) ? result.konstanten : [];

    saveAuthorProfileRun(userEmail, {
      profilText,
      konstanten,
      entwicklung,
      basis: measurement.books.map(b => ({ book_id: b.book_id, tokens: b.tokens })),
      basisSig: measurement.basisSig,
    });

    completeJob(jobId, {
      profilText, konstanten, entwicklung,
      buecher: measurement.counts.measured,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `Autorenprofil erstellt (${profilText.length} Zeichen, ${measurement.counts.measured} Buecher)`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler Autorenprofil ${userEmail}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

/**
 * POST /jobs/autorenprofil — Deutung starten.
 *
 * Kein `book_id` und damit auch keine Buch-ACL: der Lauf liest ausschliesslich
 * die eigenen Buecher des Anfragenden (Skopierung ueber `books.owner_email` in
 * db/author-profile.js). Wer angemeldet ist, darf ueber sein eigenes Werk ein
 * Profil rechnen lassen.
 *
 * `force` ueberschreibt einen von Hand editierten Text. Ohne das Flag antwortet
 * die Route `409` statt die Arbeit des Autors stillschweigend zu ersetzen.
 */
autorenprofilRouter.post('/autorenprofil', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const current = getAuthorProfile(userEmail);
  if (!current.counts.measured) {
    return res.status(400).json({ error_code: 'AUTHOR_PROFILE_NO_BOOKS' });
  }
  if (current.profile?.edited && !req.body?.force) {
    return res.status(409).json({ error_code: 'AUTHOR_PROFILE_EDITED' });
  }

  const existing = findActiveJobId('autorenprofil', userEmail, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('autorenprofil', 0, userEmail, 'job.label.autorenprofil', {}, userEmail);
  logger.info(`Autorenprofil-Job gestartet (${current.counts.measured} Buecher)`, { user: userEmail });
  enqueueJob(jobId, () => runAutorenprofilJob(jobId, userEmail));
  res.json({ jobId });
});

module.exports = { autorenprofilRouter, runAutorenprofilJob };

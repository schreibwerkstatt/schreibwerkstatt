'use strict';
// Beat-Verankerung (Plot-Werkstatt, Ist-Index): findet die tatsächlichen Fund-
// stellen der geplanten Beats im Buchtext und legt sie in plot_beat_occurrences
// ab (Full-Replace pro Beat). Rein rückwärtsgewandt — liest bestehende Inhalte,
// schreibt NIE in den Buchtext. Kein KI-Prompt/callAI: die Erkennung nutzt den
// bereits vorhandenen Embedding-Index (semantische Ähnlichkeit zu titel+
// beschreibung; die Freitext-Pipeline fusioniert intern schon FTS dazu) — fehlt
// das Backend, fällt der Anchor auf reine FTS über den Beat-Titel zurück.
//
// Der Soll-Ist-Abgleich (beat.status vs. Fundstellen-Dichte) treibt das Drift-
// Badge auf der Beat-Karte. Pendant zur Motiv-Werkstatt (routes/jobs/motif-scan.js).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  startBookJob, i18nError,
} = require('./shared');
const plotDb = require('../../db/plot');
const appSettings = require('../../lib/app-settings');
const embed = require('../../lib/embed');
const retrieval = require('../../lib/semantic-retrieval');
const { getSceneTitleForUser } = require('../../db/book-chat/figures');
const searchIndex = require('../../lib/search');
const logger = require('../../logger');

const beatAnchorRouter = express.Router();

// Fund-Kinds im Text (Seiten + Szenen — genau die, die plot_beat_occurrences via
// CHECK erlaubt; Figuren-Chunks des Embedding-Index sind für Beats nicht sinnvoll).
const SCAN_KINDS = ['page', 'scene'];
const TOP_K = 25;

const _TAG = /<\/?[^>]+>/g;
const _ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function _plainSnippet(s) {
  return String(s || '').replace(_TAG, '').replace(/&(amp|lt|gt|quot|#39);/g, m => _ENT[m] || m).trim().slice(0, 400);
}

function _occKey(kind, entityId) { return `${kind}:${entityId}`; }
function _toOcc(kind, entityId, score, snippet, source) {
  const isPage = kind === 'page';
  return { kind, pageId: isPage ? entityId : null, sceneId: isPage ? null : entityId, score, snippet, source };
}

// Fundstellen eines Beats sammeln. Query = titel + beschreibung. Semantisch (mit
// interner FTS-Fusion) wenn das Embedding-Backend läuft, sonst reine FTS über den
// Titel. Dedup pro (kind, entity) — ein Ort zählt einmal.
//
// Konfidenz ist der ROHE COSINUS (`semScore`, 0–1), nicht `score`: bei Hybrid ist
// `score` der RRF-Wert (Rang-Fusion, max. ~0.03), mit Rerank die Rerank-Relevanz —
// beides nicht gegen eine absolute Schwelle vergleichbar. Reine FTS-Fusions-
// Kandidaten (semScore null) sind semantisch nicht belegt und werden übersprungen
// (Muster routes/jobs/motif-scan.js). Gespeichert wird semScore.
//
// minScore: Cosinus-Untergrenze fürs Speichern. Für „im Buch"-Beats die Bestätigungs-
// Schwelle (plot.anchor.confirm_min_score) — ohne sie liefert die Nächster-Nachbar-
// Suche für JEDEN Beat Treffer, und „confirmed" hiesse nichts. Für „geplant"-Beats die
// höhere Promotion-Schwelle (sonst Vorschlags-Flut). Ist der Beat geplant (minScore
// = Promotion), wird der reine FTS-Fallback übersprungen: ein wörtlicher Titel-
// Treffer ist ohne Semantik ein zu schwaches Promotion-Signal.
//
// `userEmail` (gesetzt = Besitz-Filter): Szenen sind Analyse-Daten pro User, der
// Embedding-/FTS-Index hängt nur am Buch — Szenen eines Mitautors fallen weg.
async function _anchorBeat(bookId, beat, useSemantic, signalFn, minScore = 0, opts = {}) {
  const { promote = minScore > 0 } = opts;
  const scoped = Object.prototype.hasOwnProperty.call(opts, 'userEmail');
  const own = h => !scoped || h.kind !== 'scene' || getSceneTitleForUser(h.entity_id, opts.userEmail ?? null) != null;
  const found = new Map();
  const query = [beat.titel, beat.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
  if (!query) return [];

  if (useSemantic) {
    const hits = await retrieval.semanticQuery(bookId, query, { kinds: SCAN_KINDS, topK: TOP_K, signal: signalFn(), strictRerank: true });
    for (const h of hits) {
      if (h.semScore == null) continue;
      if (!own(h)) continue;
      if (minScore > 0 && h.semScore < minScore) continue;
      found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, h.semScore, _plainSnippet(h.text), 'semantic'));
    }
  } else {
    if (promote) return []; // Promotion nur mit Semantik — FTS-Titel-Treffer zu schwach.
    // Ohne Embedding-Backend: wörtliche FTS über den Beat-Titel (kürzer, präziser
    // als die ganze Beschreibung als Textblob).
    let r;
    try { r = searchIndex.query(beat.titel || '', { bookId, kinds: SCAN_KINDS, limit: TOP_K }); }
    catch (e) { logger.warn(`[beat-anchor] FTS "${beat.titel}" fehlgeschlagen: ${e.message}`); return []; }
    for (const h of (r.hits || [])) {
      if (!own(h)) continue;
      found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, null, _plainSnippet(h.snippet || h.title), 'trigger'));
    }
  }

  return [...found.values()];
}

async function runBeatAnchorJob(jobId, bookId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    const useSemantic = embed.isEnabled();
    if (useSemantic && !retrieval.indexReady(bookId)) {
      // Backend da, Index aber noch nicht vollständig (Erstindex, Modellwechsel):
      // die Suche fände nichts, ein Full-Replace mit [] hiesse „nicht im Text" →
      // Drift-Badges auf jedem Beat. Nichts anfassen. Fehler statt `done`: ein
      // `done`-Lauf in job_runs zählt als „verankert" (beatAnchorLastRun).
      throw i18nError('job.error.anchorNoIndex');
    }
    // Promotion-Schwelle für GEPLANTE Beats (hoch, sonst Vorschlags-Flut). 0 = aus.
    const promoteFloor = Number(appSettings.get('plot.anchor.promote_min_score')) || 0;
    // Bestätigungs-Schwelle für „im Buch"-Beats (Cosinus). 0 = jeder semantische Treffer.
    const confirmFloor = Number(appSettings.get('plot.anchor.confirm_min_score')) || 0;
    // Verankert werden nicht-verworfene Beats beider Status:
    //   - „im Buch": Treffer ≥ confirmFloor (Soll-Ist-Drift — ist das laut Plan
    //     Geschriebene wirklich im Text?).
    //   - „geplant": nur Treffer ≥ promoteFloor (Promotion-Erkennung — offenbar schon
    //     geschrieben? → Vorschlag „auf im Buch setzen"). Bei promoteFloor = 0 werden
    //     geplante Beats nicht gescannt (Feature aus).
    // Verworfene Beats haben kein Soll „im Text"; ihre evtl. vorhandenen Alt-Fundstellen
    // werden geleert (kein Stale-Index nach Rückstufung/Verwerfen).
    const allBeats = plotDb.listBeatsForAnchor(bookId, userEmail);
    const beats = allBeats.filter(b => !b.verworfen
      && (b.status === 'im_buch' || (b.status === 'geplant' && promoteFloor > 0)));
    const anchoredIds = new Set(beats.map(b => b.id));
    for (const b of allBeats) {
      if (!anchoredIds.has(b.id)) plotDb.replaceBeatOccurrences(b.id, bookId, []);
    }
    updateJob(jobId, { statusText: 'job.phase.beatAnchor', statusParams: { done: 0, total: beats.length }, progress: 5 });

    let totalOcc = 0;
    let failed = 0;
    for (let i = 0; i < beats.length; i++) {
      throwIfAborted();
      const beat = beats[i];
      const promote = beat.status !== 'im_buch';
      const minScore = promote ? promoteFloor : confirmFloor;
      // Ein Fehler (Embedding-/Rerank-Endpunkt weg, kaputte Query) kostet nur diesen Beat:
      // geloggt, übersprungen, seine bisherigen Fundstellen bleiben stehen (kein
      // Full-Replace mit [] — ein Ausfall ist keine Aussage „nicht im Text").
      let rows;
      try {
        rows = await _anchorBeat(bookId, beat, useSemantic, signal, minScore, { promote, userEmail });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed++;
        log.warn(`Beat-Anchor: Beat ${beat.id} übersprungen: ${e.message}`);
        continue;
      }
      // false = Beat während des Laufs gelöscht → nichts zu schreiben.
      if (plotDb.replaceBeatOccurrences(beat.id, bookId, rows)) totalOcc += rows.length;
      updateJob(jobId, {
        statusText: 'job.phase.beatAnchor', statusParams: { done: i + 1, total: beats.length },
        progress: 5 + Math.round(((i + 1) / Math.max(beats.length, 1)) * 90),
      });
    }

    log.info(`Beat-Anchor ${bookId}: ${beats.length} Beats, ${totalOcc} Fundstellen, ${failed} fehlgeschlagen (semantisch=${useSemantic}).`);
    // Kein Beat durchgekommen → Fehler statt `done`: ein `done`-Lauf zählt als
    // „verankert" (beatAnchorLastRun), obwohl nichts gesucht wurde.
    if (beats.length && failed === beats.length) throw i18nError('job.error.anchorSearchDown');
    completeJob(jobId, { beats: beats.length, occurrences: totalOcc, failed, semantic: useSemantic }, null,
      `${beats.length} Beats, ${totalOcc} Fundstellen`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Beat-Anchor Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron: hält den Ist-Index aller Bücher/User frisch (nach dem embed-Reindex).
// Ein Anchor pro (Buch, User) mit Beats; Dedup gegen laufende Jobs.
const { db } = require('../../db/schema');
async function anchorAllBooks() {
  const scopes = db.prepare('SELECT DISTINCT book_id, user_email FROM plot_beats').all();
  let enqueued = 0, skipped = 0;
  const semantic = embed.isEnabled();
  for (const { book_id, user_email } of scopes) {
    // Ohne fertigen Index würde der Lauf nur mit anchorNoIndex scheitern.
    if (semantic && !retrieval.indexReady(book_id)) { skipped++; continue; }
    if (findActiveJobId('beat-anchor', book_id, user_email)) { skipped++; continue; }
    const jobId = createJob('beat-anchor', book_id, user_email, 'job.label.beatAnchor', null, book_id);
    enqueueJob(jobId, () => runBeatAnchorJob(jobId, book_id, user_email));
    enqueued++;
  }
  logger.info(`Beat-Anchor (Cron): ${enqueued} Scope(s) eingereiht, ${skipped} übersprungen (läuft bereits).`);
  return { enqueued, skipped };
}

beatAnchorRouter.post('/beat-anchor', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'beat-anchor',
  minRole: 'editor',
  label: 'job.label.beatAnchor',
  run: (jobId, { bookId, userEmail }) => runBeatAnchorJob(jobId, bookId, userEmail),
}));

module.exports = { beatAnchorRouter, runBeatAnchorJob, anchorAllBooks, _anchorBeat };

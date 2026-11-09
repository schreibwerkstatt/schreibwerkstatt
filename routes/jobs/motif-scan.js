'use strict';
// Motiv-Erkennung (Motiv-Werkstatt, Ist-Index): findet die tatsächlichen Fund-
// stellen der katalogisierten Motive im Buchtext und legt sie in motif_occurrences
// ab (Full-Replace pro Motiv). Rein rückwärtsgewandt — liest bestehende Inhalte,
// schreibt NIE in den Buchtext. Kein KI-Prompt/callAI: die Erkennung ist hybrid
// aus dem bereits vorhandenen Embedding-Index (semantische Ähnlichkeit zur Motiv-
// Beschreibung) + der FTS5-Volltextsuche über die wörtlichen trigger_terms.
//
// Voraussetzung semantischer Teil: das Embedding-Backend (embed.*) + ein frischer
// embed-index. Fehlt es, läuft der Scan rein wörtlich (trigger_terms); Motive ohne
// Trigger bekommen dann 0 Fundstellen (ihre alten werden trotzdem geräumt).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  startBookJob, i18nError,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const embed = require('../../lib/embed');
const retrieval = require('../../lib/semantic-retrieval');
const { getSceneTitleForUser } = require('../../db/book-chat/figures');
const searchIndex = require('../../lib/search');
const contentStore = require('../../lib/content-store');
const { plainSnippet: _plainSnippet, makeLiveSnippets } = require('../../lib/anchor-snippet');
const logger = require('../../logger');
const { toIntId } = require('../../lib/validate');
const { getBookRole, hasMinRole } = require('../../db/book-access');

const motifScanRouter = express.Router();

// Fund-Kinds im Text (Seiten + Szenen — genau die, die motif_occurrences via CHECK
// erlaubt; Figuren-Chunks des Embedding-Index sind für Motive nicht sinnvoll).
const SCAN_KINDS = ['page', 'scene'];

// Fundstellen-Cap pro Motiv, buchgrössen-abhängig. Ein fixes TOP_K sättigt bei
// grossen (dichten) Büchern die Ist-Dichte: ein omnipräsentes Motiv erreicht die
// Grenze schnell, und die Knotengrösse unterscheidet „40 Stellen" nicht mehr von
// „200 Stellen". Darum skaliert das Cap mit der Zahl indizierter Seiten/Szenen
// (TOP_K_FRACTION), unten wie oben geklammert. Kleine Bücher behalten TOP_K_BASE.
const TOP_K_BASE = 40;
const TOP_K_MAX = 500;
const TOP_K_FRACTION = 0.5;
function _computeTopK(entityCount) {
  return Math.max(TOP_K_BASE, Math.min(TOP_K_MAX, Math.ceil((entityCount || 0) * TOP_K_FRACTION)));
}

// FTS-Query eines wörtlichen Trigger-Begriffs. Der Ausdruck geht durch
// lib/search#buildMatchQuery, die JEDES Wort ab 3 Zeichen selbst zum Präfix macht
// und Mehrwort-Eingaben UND-verknüpft — darum steuert diese Funktion die Präfix-
// Regel ausdrücklich über deren Syntax (Anführungszeichen = exakt):
//   - Einzelwort ab TRIGGER_PREFIX_MIN Zeichen → Präfix (`Wasser` → `Wasser*`),
//     damit deutsche Flexion (Wassers, Wasserfall) mitgefunden wird.
//   - kürzeres Einzelwort → exakt (`"See"`); Präfix überdehnte: See* → Seele.
//   - Mehrwort-Begriff → exakte Phrase (`"rotes Kleid"`). Ohne Anführungszeichen
//     träfe jede Seite, auf der «rot…» und «Kleid…» irgendwo stehen — und ein
//     Trigger-Treffer zählt als 100 % und fällt nie unter den Score-Floor.
//   - ein vom Autor selbst gesetztes `*` am Einzelwort bleibt respektiert.
const TRIGGER_PREFIX_MIN = 5;
function _triggerQuery(term) {
  const t = String(term || '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/\s/.test(t)) return `"${t.replace(/\*+$/, '').trim()}"`;
  if (t.endsWith('*')) return t;
  return t.length >= TRIGGER_PREFIX_MIN ? `${t}*` : `"${t}"`;
}

function _occKey(kind, entityId) { return `${kind}:${entityId}`; }
function _toOcc(kind, entityId, score, snippet, source) {
  const isPage = kind === 'page';
  return { kind, pageId: isPage ? entityId : null, sceneId: isPage ? null : entityId, score, snippet, source };
}

// Fundstellen eines Motivs sammeln. Dedup pro (kind, entity) — semantischer Treffer
// gewinnt gegen wörtlichen (höhere Vertrauensstufe); ein Ort zählt einmal (Ist-Dichte).
// Szenen sind Analyse-Daten pro User, beide Indizes hängen nur am Buch: Szenen
// eines Mitautors (figure_scenes.user_email) werden nie zu eigenen Fundstellen;
// der User-Scope greift schon in der Suche (vor dem topK-Schnitt), der `own`-
// Filter bleibt als zweite Schicht.
// `snippetFor` (hit → Auszug | null): der Job reicht lib/anchor-snippet.js#
// makeLiveSnippets durch — Seiten-Auszug aus dem Live-Text, null = Stelle steht
// so nicht mehr auf der Seite → semantischer Treffer verworfen. Default: Chunk-Text.
async function _scanMotif(bookId, motif, useSemantic, signalFn, topK, userEmail = null, snippetFor = null) {
  const found = new Map();
  const own = h => h.kind !== 'scene' || getSceneTitleForUser(h.entity_id, userEmail) != null;

  if (useSemantic) {
    const query = [motif.name, motif.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
    if (query) {
      const hits = await retrieval.semanticQuery(bookId, query, { kinds: SCAN_KINDS, topK, signal: signalFn(), strictRerank: true, user: userEmail, background: true });
      for (const h of hits) {
        // Als Konfidenz zählt der rohe Cosinus (0–1, absolut interpretierbar für
        // %-Anzeige + Score-Floor). Reine FTS-Fusions-Kandidaten (kein Cosinus)
        // sind semantisch nicht belegt → hier überspringen; die wörtliche Erkennung
        // deckt Trigger-Begriffe separat und bewusst ab.
        if (h.semScore == null) continue;
        if (!own(h)) continue;
        const snippet = snippetFor ? await snippetFor(h) : _plainSnippet(h.text);
        if (snippet == null) continue;
        found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, h.semScore, snippet, 'semantic'));
      }
    }
  }

  for (const term of motif.trigger_terms || []) {
    const q = _triggerQuery(term);
    if (!q) continue;
    // Ein fehlgeschlagener Begriff wirft weiter: der Lauf überspringt dann das
    // ganze Motiv und lässt seine bisherigen Fundstellen stehen — ein Full-Replace
    // ohne diesen Begriff räumte dessen Treffer stillschweigend ab.
    const r = searchIndex.query(q, { bookId, kinds: SCAN_KINDS, limit: topK, user: userEmail });
    for (const h of (r.hits || [])) {
      if (!own(h)) continue;
      const key = _occKey(h.kind, h.entity_id);
      if (found.has(key)) continue; // semantischer Treffer behält Vorrang
      found.set(key, _toOcc(h.kind, h.entity_id, null, _plainSnippet(h.snippet || h.title), 'trigger'));
    }
  }

  return [...found.values()];
}

// `onlyMotifId`: nur dieses Motiv scannen (Knopf „Nur dieses Motiv neu suchen"
// nach einer Trigger-Änderung). Gleicher Pfad wie der Buch-Scan, nur die Motiv-
// Liste ist auf eins gefiltert — Full-Replace, Score-Floor und Cap bleiben gleich.
async function runMotifScanJob(jobId, bookId, userEmail, onlyMotifId = null) {
  const log = makeJobLogger(jobId);
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    const useSemantic = embed.isEnabled();
    if (useSemantic && !retrieval.indexReady(bookId)) {
      // Backend da, Index aber unvollständig (Erstindex läuft, Modellwechsel):
      // ein Full-Replace nur mit Trigger-Treffern räumte alle semantischen
      // Fundstellen ab, und Motive ohne Trigger stünden als „nicht im Buch" da.
      // Nichts anfassen; der nächste Lauf nach dem Index holt es nach.
      log.info(`Motiv-Scan ${bookId}: übersprungen (Embedding-Index nicht fertig).`);
      updateJob(jobId, { statusText: 'job.phase.skippedNoIndex' });
      completeJob(jobId, { motifs: 0, occurrences: 0, semantic: true, skipped: 'noIndex' }, null, 'übersprungen (kein Index)');
      return;
    }
    const motifs = motifsDb.listMotifs(bookId, userEmail)
      .filter(m => !onlyMotifId || m.id === onlyMotifId);
    // Fundstellen-Cap einmal pro Lauf aus der Buchgrösse ableiten (Seiten + Szenen
    // im FTS-Index), damit dichte Motive in grossen Büchern nicht bei 40 plateauen.
    const topK = _computeTopK(searchIndex.countEntities(bookId, SCAN_KINDS));
    updateJob(jobId, { statusText: 'job.phase.motivScan', statusParams: { done: 0, total: motifs.length }, progress: 5 });

    let totalOcc = 0;
    let failed = 0;
    const snippetFor = makeLiveSnippets(bookId);
    for (let i = 0; i < motifs.length; i++) {
      throwIfAborted();
      const motif = motifs[i];
      // Ein Fehler (Embedding-/Rerank-Endpunkt weg) kostet nur dieses Motiv:
      // seine bisherigen Fundstellen bleiben stehen — ein Full-Replace mit dem,
      // was ohne Semantik/Rerank-Tor übrig bliebe, wäre keine Aussage über den Text.
      let rows;
      try {
        rows = await _scanMotif(bookId, motif, useSemantic, signal, topK, userEmail, snippetFor);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed++;
        log.warn(`Motiv-Scan: Motiv ${motif.id} übersprungen: ${e.message}`);
        continue;
      }
      // false = Motiv während des Laufs gelöscht → nichts zu schreiben.
      if (motifsDb.replaceOccurrences(motif.id, bookId, rows)) totalOcc += rows.length;
      updateJob(jobId, {
        statusText: 'job.phase.motivScan', statusParams: { done: i + 1, total: motifs.length },
        progress: 5 + Math.round(((i + 1) / Math.max(motifs.length, 1)) * 90),
      });
    }

    log.info(`Motiv-Scan ${bookId}: ${motifs.length} Motive, ${totalOcc} Fundstellen, ${failed} fehlgeschlagen (semantisch=${useSemantic}, topK=${topK}).`);
    if (motifs.length && failed === motifs.length) throw i18nError('job.error.anchorSearchDown');
    completeJob(jobId, { motifs: motifs.length, occurrences: totalOcc, failed, semantic: useSemantic }, null,
      `${motifs.length} Motive, ${totalOcc} Fundstellen`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Motiv-Scan Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron: hält den Ist-Index aller Bücher/User frisch (nach dem embed-Reindex).
// Ein Scan pro (Buch, User) mit katalogisierten Motiven; Dedup gegen laufende Jobs.
const { db } = require('../../db/schema');
async function scanAllBooks() {
  const scopes = db.prepare('SELECT DISTINCT book_id, user_email FROM motifs').all();
  let enqueued = 0, skipped = 0;
  const semantic = embed.isEnabled();
  for (const { book_id, user_email } of scopes) {
    // Wer das Buch nicht mehr sehen darf (Zugriff entzogen), bekommt keinen Scan:
    // sonst schriebe der Cron Auszüge des Buchs in dessen Zeilen weiter. Gleiche
    // Mindestrolle wie der manuelle Start.
    const role = getBookRole(book_id, user_email);
    if (!role || !hasMinRole(role, 'lektor')) { skipped++; continue; }
    // Ohne fertigen Index endete der Lauf ohnehin als Skip.
    if (semantic && !retrieval.indexReady(book_id)) { skipped++; continue; }
    if (findActiveJobId('motif-scan', book_id, user_email)) { skipped++; continue; }
    const jobId = createJob('motif-scan', book_id, user_email, 'job.label.motivScan', null, book_id);
    enqueueJob(jobId, () => runMotifScanJob(jobId, book_id, user_email));
    enqueued++;
  }
  logger.info(`Motiv-Scan (Cron): ${enqueued} Scope(s) eingereiht, ${skipped} übersprungen (läuft bereits, kein Index oder kein Zugriff).`);
  return { enqueued, skipped };
}

// Body `{ book_id, motif_id? }`. Mit `motif_id` ein Einzel-Scan: eigener Dedup-
// Schlüssel, damit der Einzel-Scan von Motiv B nicht den laufenden von A
// zurückbekommt; das Motiv muss Buch + User gehören.
motifScanRouter.post('/motif-scan', jsonBody, (req, res) => {
  const motifId = req.body?.motif_id == null ? null : toIntId(req.body.motif_id);
  if (req.body?.motif_id != null && !motifId) return res.status(400).json({ error_code: 'INVALID_ID' });
  return startBookJob(req, res, {
    type: 'motif-scan',
    minRole: 'lektor',
    label: 'job.label.motivScan',
    dedupId: motifId ? (bookId) => `${bookId}:m${motifId}` : null,
    precheck: motifId ? (bookId, userEmail) => {
      const m = motifsDb.getMotif(motifId);
      return (m && m.book_id === bookId && m.user_email === userEmail)
        ? null : { status: 404, error_code: 'MOTIF_NOT_FOUND' };
    } : null,
    run: (jobId, { bookId, userEmail }) => runMotifScanJob(jobId, bookId, userEmail, motifId),
  });
});

module.exports = { motifScanRouter, runMotifScanJob, scanAllBooks, _triggerQuery, _computeTopK, _scanMotif };

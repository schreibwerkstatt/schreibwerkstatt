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
const logger = require('../../logger');

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

// FTS-Query eines wörtlichen Trigger-Begriffs. Einzelwörter ab TRIGGER_PREFIX_MIN
// Zeichen werden als Präfix gesucht (`Wasser` → `Wasser*`), damit deutsche Flexion
// (Wassers, Wasserns, Wasserfall) mitgefunden wird — der grösste Recall-Verlust bei
// exaktem Token-Match. Kurze Begriffe (See, Weg) bleiben exakt (Präfix überdehnt
// sonst: See* → Seele, sehen). Ein vom Autor selbst gesetztes `*` bleibt respektiert;
// Mehrwort-Begriffe gehen unverändert durch (buildMatchQuery UND-verknüpft sie).
const TRIGGER_PREFIX_MIN = 5;
function _triggerQuery(term) {
  const t = String(term || '').trim();
  if (!t || /\s/.test(t) || t.endsWith('*')) return t;
  return t.length >= TRIGGER_PREFIX_MIN ? `${t}*` : t;
}

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

// Fundstellen eines Motivs sammeln. Dedup pro (kind, entity) — semantischer Treffer
// gewinnt gegen wörtlichen (höhere Vertrauensstufe); ein Ort zählt einmal (Ist-Dichte).
// Szenen sind Analyse-Daten pro User, beide Indizes hängen nur am Buch: Szenen
// eines Mitautors (figure_scenes.user_email) werden nie zu eigenen Fundstellen.
async function _scanMotif(bookId, motif, useSemantic, signalFn, topK, userEmail = null) {
  const found = new Map();
  const own = h => h.kind !== 'scene' || getSceneTitleForUser(h.entity_id, userEmail) != null;

  if (useSemantic) {
    const query = [motif.name, motif.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
    if (query) {
      const hits = await retrieval.semanticQuery(bookId, query, { kinds: SCAN_KINDS, topK, signal: signalFn(), strictRerank: true });
      for (const h of hits) {
        // Als Konfidenz zählt der rohe Cosinus (0–1, absolut interpretierbar für
        // %-Anzeige + Score-Floor). Reine FTS-Fusions-Kandidaten (kein Cosinus)
        // sind semantisch nicht belegt → hier überspringen; die wörtliche Erkennung
        // deckt Trigger-Begriffe separat und bewusst ab.
        if (h.semScore == null) continue;
        if (!own(h)) continue;
        found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, h.semScore, _plainSnippet(h.text), 'semantic'));
      }
    }
  }

  for (const term of motif.trigger_terms || []) {
    const q = _triggerQuery(term);
    if (!q) continue;
    let r;
    try { r = searchIndex.query(q, { bookId, kinds: SCAN_KINDS, limit: topK }); }
    catch (e) { logger.warn(`[motiv-scan] FTS "${term}" fehlgeschlagen: ${e.message}`); continue; }
    for (const h of (r.hits || [])) {
      if (!own(h)) continue;
      const key = _occKey(h.kind, h.entity_id);
      if (found.has(key)) continue; // semantischer Treffer behält Vorrang
      found.set(key, _toOcc(h.kind, h.entity_id, null, _plainSnippet(h.snippet || h.title), 'trigger'));
    }
  }

  return [...found.values()];
}

async function runMotifScanJob(jobId, bookId, userEmail) {
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
    const motifs = motifsDb.listMotifs(bookId, userEmail);
    // Fundstellen-Cap einmal pro Lauf aus der Buchgrösse ableiten (Seiten + Szenen
    // im FTS-Index), damit dichte Motive in grossen Büchern nicht bei 40 plateauen.
    const topK = _computeTopK(searchIndex.countEntities(bookId, SCAN_KINDS));
    updateJob(jobId, { statusText: 'job.phase.motivScan', statusParams: { done: 0, total: motifs.length }, progress: 5 });

    let totalOcc = 0;
    let failed = 0;
    for (let i = 0; i < motifs.length; i++) {
      throwIfAborted();
      const motif = motifs[i];
      // Ein Fehler (Embedding-/Rerank-Endpunkt weg) kostet nur dieses Motiv:
      // seine bisherigen Fundstellen bleiben stehen — ein Full-Replace mit dem,
      // was ohne Semantik/Rerank-Tor übrig bliebe, wäre keine Aussage über den Text.
      let rows;
      try {
        rows = await _scanMotif(bookId, motif, useSemantic, signal, topK, userEmail);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed++;
        log.warn(`Motiv-Scan: Motiv ${motif.id} übersprungen: ${e.message}`);
        continue;
      }
      motifsDb.replaceOccurrences(motif.id, bookId, rows);
      totalOcc += rows.length;
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
    // Ohne fertigen Index endete der Lauf ohnehin als Skip.
    if (semantic && !retrieval.indexReady(book_id)) { skipped++; continue; }
    if (findActiveJobId('motif-scan', book_id, user_email)) { skipped++; continue; }
    const jobId = createJob('motif-scan', book_id, user_email, 'job.label.motivScan', null, book_id);
    enqueueJob(jobId, () => runMotifScanJob(jobId, book_id, user_email));
    enqueued++;
  }
  logger.info(`Motiv-Scan (Cron): ${enqueued} Scope(s) eingereiht, ${skipped} übersprungen (läuft bereits).`);
  return { enqueued, skipped };
}

motifScanRouter.post('/motif-scan', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'motif-scan',
  minRole: 'lektor',
  label: 'job.label.motivScan',
  run: (jobId, { bookId, userEmail }) => runMotifScanJob(jobId, bookId, userEmail),
}));

module.exports = { motifScanRouter, runMotifScanJob, scanAllBooks, _triggerQuery, _computeTopK, _scanMotif };

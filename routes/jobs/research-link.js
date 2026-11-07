'use strict';
// Recherche-Verknüpfungs-Job (KI-first, rückwärtsgewandt): nimmt EINEN Recherche-
// Schnipsel und schlägt Verknüpfungen zu bereits existierenden Buch-Entitäten
// (Figuren/Orte/Szenen/Plot-Beats) vor. Persistiert NICHTS automatisch — liefert
// Vorschläge zurück, die der User in der Karte bestätigt (POST /research/:id/links).
// Generiert keinen Buchtext und schlägt keine neuen Entitäten vor.
const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { semanticLivePassages } = require('./research-passages');
const { researchItemForLinking, researchItemLinkKeys, researchLinkCandidates } = require('../../db/research-jobs');

const researchLinkRouter = express.Router();
const MAX_CANDIDATES = 200;

// Seiten-Vorschlaege kommen nicht vom Modell, sondern aus den Embeddings: welche
// Manuskriptseiten stehen dem Fundstueck inhaltlich am naechsten. Das ist genau
// die Verknuepfung, die „eingearbeitet" belegt — und die das Modell ohne den Text
// aller Seiten nicht finden kann. `grund` ist ein Auszug der Fundstelle (Zitat,
// sprachneutral), kein KI-Text — geschnitten aus dem LIVE-Seitentext, denn der
// Index-Chunk kann hinter dem Seitenstand zurückliegen. Steht die Stelle so nicht
// mehr auf der Seite, fällt der Vorschlag weg (lib/live-passage.js).
const PAGE_SUGGEST_MAX = 3;
const PAGE_SNIPPET_MAX = 160;

async function _semanticPageSuggestions(item, bookId, signal) {
  const passages = await semanticLivePassages(bookId, item, {
    limit: PAGE_SUGGEST_MAX, topK: PAGE_SUGGEST_MAX * 3, maxChars: PAGE_SNIPPET_MAX, signal,
  });
  return passages.map((p) => {
    const snip = p.text.replace(/\s+/g, ' ').trim();
    return {
      target_kind: 'page',
      target_id: p.page_id,
      label: p.page_name,
      grund: `„${snip}${snip.length >= PAGE_SNIPPET_MAX ? '…' : ''}"`,
      source: 'semantic',
    };
  });
}

// KI-«art» → research_item_links.target_kind.
const ART_TO_KIND = { figur: 'figure', ort: 'location', szene: 'scene', beat: 'beat', strang: 'thread' };

async function runResearchLinkJob(jobId, itemId, bookId, userEmail, { signal } = {}) {
  const logger = makeJobLogger(jobId);
  try {
    updateJob(jobId, { statusText: 'job.phase.researchLinking', progress: 15 });
    const item = researchItemForLinking(itemId, bookId);
    if (!item) throw i18nError('job.error.researchItemMissing');

    // Bereits bestehende Verknüpfungen ausblenden (Welt-Entitäten wie Seiten).
    const existing = researchItemLinkKeys(itemId);

    // Seiten zuerst (billig, ohne Modell). Ein Embedding-Ausfall kostet nur sie.
    let pageSuggestions = [];
    try {
      pageSuggestions = (await _semanticPageSuggestions(item, bookId, signal))
        .filter(sg => !existing.has(`page:${sg.target_id}`));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`Recherche-Verknüpfung: Seiten-Vorschläge nicht verfügbar (${e.message})`);
    }

    const cands = researchLinkCandidates(bookId, userEmail, MAX_CANDIDATES);
    const total = cands.figur.length + cands.ort.length + cands.szene.length
      + cands.beat.length + cands.strang.length;
    if (!total) {
      completeJob(jobId, { suggestions: pageSuggestions, empty: !pageSuggestions.length }, null,
        `${pageSuggestions.length} Seiten, 0 Kandidaten`);
      return;
    }

    // id → { kind, label, ref_id } für Validierung (KI darf nur diese ids zurückgeben).
    // ref_id = öffentliche Kennung (Figur/Ort) für die Entitäts-Referenz im Frontend.
    const byArtId = new Map();
    for (const [art, kind] of Object.entries(ART_TO_KIND)) {
      for (const c of cands[art]) byArtId.set(`${art}:${c.id}`, { kind, id: c.id, label: c.label || '', ref_id: c.ref_id });
    }

    const { buildSystemResearchLink, buildResearchLinkPrompt, SCHEMA_RESEARCH_LINK } = await getPrompts(userEmail);
    const tok = { in: 0, out: 0, ms: 0 };
    const maxOut = 600 + Math.min(total, 60) * 40;
    const result = await aiCall(jobId, tok,
      buildResearchLinkPrompt(item, cands),
      buildSystemResearchLink(),
      15, 90, Math.max(800, total * 20), 0.2, maxOut, undefined, SCHEMA_RESEARCH_LINK,
    );
    if (!Array.isArray(result?.links)) throw i18nError('job.error.researchLinksMissing');

    const seen = new Set();
    const suggestions = [...pageSuggestions];
    for (const l of result.links) {
      const art = String(l?.art || '').trim();
      const cand = byArtId.get(`${art}:${toIntId(l?.id)}`);
      if (!cand) continue;
      const key = `${cand.kind}:${cand.id}`;
      if (seen.has(key) || existing.has(key)) continue;
      seen.add(key);
      suggestions.push({
        target_kind: cand.kind,
        target_id: cand.id,
        ...(cand.ref_id ? { ref_id: cand.ref_id } : {}),
        label: cand.label,
        grund: String(l?.grund || '').trim().slice(0, 200),
      });
    }

    logger.info(`Recherche-Verknüpfung: ${suggestions.length} Vorschlag/Vorschläge (${pageSuggestions.length} Seiten) aus ${total} Kandidaten`);
    completeJob(jobId, { suggestions, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${suggestions.length} Vorschlaege`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Recherche-Verknüpfung Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

researchLinkRouter.post('/research-link', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  const item_id = toIntId(req.body?.item_id);
  if (!book_id || !item_id) return res.status(400).json({ error_code: 'INVALID_IDS' });
  setContext({ book: book_id });
  {
    if (!guardBook(req, res, book_id, 'editor')) return;
  }
  const userEmail = sessionEmail(req);
  const entityKey = `${book_id}|${item_id}`;
  const existing = findActiveJobId('research-link', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('research-link', book_id, userEmail, 'job.label.researchLink', null, entityKey);
  enqueueJob(jobId, () => runResearchLinkJob(jobId, item_id, book_id, userEmail,
    { signal: jobAbortControllers.get(jobId)?.signal }));
  res.json({ jobId });
});

module.exports = { researchLinkRouter, runResearchLinkJob };

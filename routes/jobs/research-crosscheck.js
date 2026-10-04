'use strict';
// Recherche-Abgleich: prueft das Manuskript gegen das, was der Autor selbst im
// Recherche-Board gesammelt hat — Fakten (Widerspruch?) und Zitate (Wortlaut
// abweichend?). Nicht gegen die Wirklichkeit: das macht der Weltfakten-
// Faktencheck (routes/jobs/komplett/job-faktencheck.js, Web-Suche). Darum
// provider-neutral und ohne Web.
//
// Ablauf: Kandidaten (fact/quote, nicht archiviert, nicht verworfen) → je
// Kandidat die Manuskriptstellen, an denen er etwas sagen koennte (verknuepfte
// Seiten/Kapitel, sonst die semantisch naechsten Seiten) → KI-Urteil in kleinen
// Buendeln → nur Befunde, deren `stelle` woertlich im gelieferten Text steht.
// Persistenz: research_item_findings (db/research-findings.js), je Lauf ersetzt.
// Rueckwaertsgewandt: meldet, schlaegt keinen Text vor, aendert nichts am Buch.

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps, htmlToTextForPrompt, jobAbortControllers,
  createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { guardBook, sessionEmail } = require('../../lib/acl');
const contentStore = require('../../lib/content-store');
const { researchPageHits } = require('../../lib/research-retrieval');
const { bestLivePassage } = require('../../lib/live-passage');
const { replaceFindings, placePageIds, FINDING_TYPES } = require('../../db/research-findings');

const router = express.Router();

const CANDIDATE_CAP = 40;
const BATCH = 5;
const PAGES_PER_ITEM = 3;
// Ausschnitt je verknuepfter Seite: genug fuer Absaetze, die den Fakt tragen,
// ohne ein ganzes Kapitel pro Fundstueck in den Prompt zu kippen.
const PAGE_TEXT_MAX = 6000;
const STELLE_MAX = 400;
// Ausschnitt um eine semantisch gefundene Stelle (live nachgeschlagen, s.u.).
const HIT_PASSAGE_MAX = 2000;

const _norm = (s) => String(s || '').replace(/[“”„«»"]/g, '"').replace(/[‘’‚]/g, "'").replace(/\s+/g, ' ').trim();

function _candidates(bookId, itemId) {
  const where = ["ri.book_id = ?", "ri.kind IN ('fact','quote')", 'ri.archived = 0', "ri.status <> 'verworfen'"];
  const args = [bookId];
  if (itemId) { where.push('ri.id = ?'); args.push(itemId); }
  return db.prepare(
    `SELECT ri.id, ri.kind, ri.title, ri.body, ri.source, ri.doc_text
       FROM research_items ri WHERE ${where.join(' AND ')}
      ORDER BY ri.pinned DESC, ri.updated_at DESC LIMIT ${CANDIDATE_CAP + 1}`
  ).all(...args);
}

// Manuskriptstellen eines Kandidaten: verknuepfte Seiten zuerst (der Autor hat
// gesagt, wo es hingehoert), sonst die semantisch naechsten Seiten-Chunks.
// Der Chunk ist nur Wegweiser: Prompt und `stelle`-Pruefung laufen gegen den
// AKTUELLEN Seitentext (der Index kann hinter dem Seitenstand liegen). Findet
// sich die Chunk-Stelle nicht mehr (umgeschrieben/geloescht), faellt die Seite
// weg — ein unverwandter Absatz waere kein Beleg.
async function _passages(bookId, item, signal) {
  const linked = placePageIds(item.id).slice(0, PAGES_PER_ITEM);
  const out = [];
  for (const pageId of linked) {
    const page = await contentStore.loadPage(pageId).catch(() => null);
    if (!page || page.book_id !== bookId) continue;
    const text = htmlToTextForPrompt(page.html || '').trim();
    if (text) out.push({ page_id: pageId, page_name: page.name || '', text: text.slice(0, PAGE_TEXT_MAX) });
  }
  if (out.length) return out;
  const hits = await researchPageHits(bookId, item, { topK: PAGES_PER_ITEM * 2, signal });
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.entity_id) || !h.text) continue;
    seen.add(h.entity_id);
    const page = await contentStore.loadPage(h.entity_id).catch(() => null);
    if (!page || page.book_id !== bookId) continue;
    const live = bestLivePassage(htmlToTextForPrompt(page.html || ''), h.text, { maxChars: HIT_PASSAGE_MAX });
    if (!live || !live.text) continue;
    out.push({ page_id: h.entity_id, page_name: page.name || '', text: live.text });
    if (out.length >= PAGES_PER_ITEM) break;
  }
  return out;
}

/** Modell-Befunde gegen die gelieferten Daten pruefen: ids aus dem Buendel, Seite
 *  aus den Stellen DIESES Kandidaten, `stelle` woertlich im Seitentext, `zitat`
 *  nur bei Zitat-Fundstuecken. Alles andere faellt weg (Halluzinationsschutz). */
function validateFindings(raw, batch) {
  const byId = new Map(batch.map(c => [c.id, c]));
  const out = [];
  const seen = new Set();
  for (const f of (Array.isArray(raw) ? raw : [])) {
    const c = byId.get(toIntId(f?.item_id));
    if (!c) continue;
    const typ = String(f?.typ || '').trim();
    if (!FINDING_TYPES.has(typ) || (typ === 'zitat' && c.kind !== 'quote')) continue;
    const pageId = toIntId(f?.page_id);
    const passage = c.passages.find(p => p.page_id === pageId);
    const stelle = String(f?.stelle || '').trim().slice(0, STELLE_MAX);
    if (!passage || stelle.length < 8 || !_norm(passage.text).includes(_norm(stelle))) continue;
    const key = `${c.id}:${pageId}:${_norm(stelle)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ item_id: c.id, page_id: pageId, typ, stelle, erklaerung: String(f?.erklaerung || '').trim().slice(0, 500) });
  }
  return out;
}

async function runResearchCrosscheckJob(jobId, bookId, itemId, userEmail) {
  const logger = makeJobLogger(jobId);
  const signal = jobAbortControllers.get(jobId)?.signal;
  try {
    updateJob(jobId, { statusText: 'job.phase.researchCrosscheckPassages', progress: 5 });
    const all = _candidates(bookId, itemId);
    const capped = all.length > CANDIDATE_CAP;
    const list = all.slice(0, CANDIDATE_CAP);
    const checkable = [];
    let unchecked = 0;
    for (const item of list) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const passages = await _passages(bookId, item, signal);
      if (passages.length) checkable.push({ ...item, passages }); else unchecked += 1;
    }
    if (!checkable.length) {
      completeJob(jobId, { checked: 0, findings: 0, unchecked, capped }, null, '0 pruefbar');
      return;
    }

    const { buildSystemResearchCrosscheck, buildResearchCrosscheckPrompt, SCHEMA_RESEARCH_CROSSCHECK } = await getPrompts(userEmail);
    const tok = { in: 0, out: 0, ms: 0 };
    const findings = [];
    const batches = [];
    for (let i = 0; i < checkable.length; i += BATCH) batches.push(checkable.slice(i, i + BATCH));
    for (let b = 0; b < batches.length; b++) {
      const from = 10 + Math.round((b / batches.length) * 85);
      const to = 10 + Math.round(((b + 1) / batches.length) * 85);
      updateJob(jobId, { statusText: 'job.phase.researchCrosscheck', statusParams: { done: b * BATCH, total: checkable.length } });
      const result = await aiCall(jobId, tok,
        buildResearchCrosscheckPrompt(batches[b]),
        buildSystemResearchCrosscheck(),
        from, to, 1500, 0.1, 2000, undefined, SCHEMA_RESEARCH_CROSSCHECK,
      );
      if (!Array.isArray(result?.befunde)) throw i18nError('job.error.researchCrosscheckInvalid');
      findings.push(...validateFindings(result.befunde, batches[b]));
    }

    replaceFindings(bookId, checkable.map(c => c.id), findings);
    logger.info(`Recherche-Abgleich: ${checkable.length} geprueft, ${findings.length} Befunde, ${unchecked} ohne Manuskriptstelle`);
    completeJob(jobId, {
      checked: checkable.length, findings: findings.length, unchecked, capped,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${findings.length} Befunde`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Recherche-Abgleich Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

router.post('/research-crosscheck', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  setContext({ book: bookId });
  const itemId = req.body?.item_id != null ? toIntId(req.body.item_id) : null;
  if (req.body?.item_id != null && !itemId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  const entityKey = itemId ? `${bookId}|${itemId}` : String(bookId);
  const existing = findActiveJobId('research-crosscheck', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('research-crosscheck', bookId, userEmail, 'job.label.researchCrosscheck', null, entityKey);
  enqueueJob(jobId, () => runResearchCrosscheckJob(jobId, bookId, itemId, userEmail));
  res.json({ jobId });
});

module.exports = { researchCrosscheckRouter: router, runResearchCrosscheckJob, validateFindings };

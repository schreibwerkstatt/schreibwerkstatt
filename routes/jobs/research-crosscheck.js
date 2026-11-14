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
// Persistenz: research_item_findings (db/research-findings.js), je Buendel
// ersetzt — ein spaeterer Fehler verwirft fertige Buendel nicht.
// Rueckwaertsgewandt: meldet, schlaegt keinen Text vor, aendert nichts am Buch.
//
// Ungeprueft bleiben (`unchecked`): Fundstuecke ohne Manuskriptstelle und solche,
// die an einem Fehler scheitern (Embedding-Ausfall, Antwort auch als Einzel-
// Buendel abgeschnitten). Alte Befunde fallen nur im ersten Fall weg — die Stelle
// gibt es nicht mehr; nach einem Fehler bleiben sie stehen (`failed`).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps, htmlToTextForPrompt, jobAbortControllers,
  createJob, enqueueJob, findActiveJobId, jsonBody,
  applyTierAiOverrides,
  bookTextOpts,
} = require('./shared');
const { resolveProvider } = require('../../lib/ai');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { guardBook, sessionEmail } = require('../../lib/acl');
const contentStore = require('../../lib/content-store');
const { DOC_QUERY_CHARS } = require('../../lib/research-retrieval');
const { semanticLivePassages } = require('./research-passages');
const { replaceFindings, placePageIds, FINDING_TYPES } = require('../../db/research-findings');
const { crosscheckCandidates } = require('../../db/research-jobs');

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
// Output-Deckel je Buendel: Huelle + je Fundstueck Platz fuer einige Befunde
// (stelle ≤ 400 Zeichen + erklaerung). aiCall kappt ihn auf den Provider-Deckel;
// Schema und Modell bleiben je Call gleich (kein Cache-Bruch).
const OUT_BASE_TOKENS = 600;
const OUT_PER_ITEM_TOKENS = 500;
const batchMaxTokens = (n) => OUT_BASE_TOKENS + Math.max(1, n) * OUT_PER_ITEM_TOKENS;

const _norm = (s) => String(s || '').replace(/[“”„«»"]/g, '"').replace(/[‘’‚]/g, "'").replace(/\s+/g, ' ').trim();

const _abort = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// Manuskriptstellen eines Kandidaten: verknuepfte Seiten zuerst (der Autor hat
// gesagt, wo es hingehoert), sonst die semantisch naechsten Seiten-Chunks
// (./research-passages.js: live nachgeschlagen, verschwundene Stellen fallen weg).
// `error`: die Embedding-Suche fiel aus — das Fundstueck ist dann ungeprueft,
// nicht stellenlos. Ein Job-Abbruch wird weitergeworfen.
async function _passages(bookId, item, signal, logger) {
  const linked = placePageIds(item.id).slice(0, PAGES_PER_ITEM);
  const out = [];
  for (const pageId of linked) {
    const page = await contentStore.loadPage(pageId).catch(() => null);
    if (!page || page.book_id !== bookId) continue;
    const text = htmlToTextForPrompt(page.html || '', bookTextOpts(bookId)).trim();
    if (text) out.push({ page_id: pageId, page_name: page.name || '', text: text.slice(0, PAGE_TEXT_MAX) });
  }
  if (out.length) return { passages: out, error: false };
  try {
    const passages = await semanticLivePassages(bookId, item, {
      limit: PAGES_PER_ITEM, topK: PAGES_PER_ITEM * 2, maxChars: HIT_PASSAGE_MAX, signal,
    });
    return { passages, error: false };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    logger?.warn?.(`Recherche-Abgleich: Stellen fuer Fundstueck ${item.id} nicht verfuegbar (${e.message})`);
    return { passages: [], error: true };
  }
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
  // Stufe «standard» (shared/model-tier.js) — vor chunkLimitsFor, die liest das Bag-Modell.
  applyTierAiOverrides(jobId, 'research-crosscheck', resolveProvider({ userEmail }), logger);
  const signal = jobAbortControllers.get(jobId)?.signal;
  try {
    updateJob(jobId, { statusText: 'job.phase.researchCrosscheckPassages', progress: 5 });
    const all = crosscheckCandidates(bookId, itemId, { cap: CANDIDATE_CAP, docChars: DOC_QUERY_CHARS });
    const capped = all.length > CANDIDATE_CAP;
    const list = all.slice(0, CANDIDATE_CAP);
    const checkable = [];
    const noPlace = [];
    const failed = [];
    for (const item of list) {
      if (signal?.aborted) throw _abort();
      const { passages, error } = await _passages(bookId, item, signal, logger);
      if (passages.length) checkable.push({ ...item, passages });
      else if (error) failed.push(item.id);
      else noPlace.push(item.id);
    }
    // Ohne Stelle: alte Befunde zeigen auf eine Stelle, die es so nicht mehr gibt.
    if (noPlace.length) replaceFindings(bookId, noPlace, []);
    const result = (checked, findings) => ({
      checked, findings, unchecked: noPlace.length + failed.length, failed: failed.length, capped,
    });
    if (!checkable.length) {
      completeJob(jobId, result(0, 0), null, '0 pruefbar');
      return;
    }

    const { buildSystemResearchCrosscheck, buildResearchCrosscheckPrompt, SCHEMA_RESEARCH_CROSSCHECK } = await getPrompts(userEmail);
    const system = buildSystemResearchCrosscheck();
    const tok = { in: 0, out: 0, ms: 0 };
    let findingCount = 0;
    let checkedCount = 0;

    // Ein Buendel pruefen und seine Befunde sofort ersetzen. Abgeschnittene
    // Antwort → halbieren und beide Haelften einzeln; ein Einzel-Fundstueck,
    // das auch so nicht passt, bleibt ungeprueft (seine alten Befunde bleiben).
    const checkBatch = async (batch, from, to) => {
      let raw;
      try {
        raw = await aiCall(jobId, tok,
          buildResearchCrosscheckPrompt(batch), system,
          from, to, 1500, 0.1, batchMaxTokens(batch.length), undefined, SCHEMA_RESEARCH_CROSSCHECK,
        );
      } catch (e) {
        if (e?.message !== 'job.error.aiTruncated') throw e;
        if (batch.length === 1) {
          logger.warn(`Recherche-Abgleich: Antwort fuer Fundstueck ${batch[0].id} auch einzeln abgeschnitten — ungeprueft`);
          failed.push(batch[0].id);
          return;
        }
        const mid = Math.ceil(batch.length / 2);
        logger.info(`Recherche-Abgleich: Antwort abgeschnitten, Buendel ${batch.length} → ${mid} + ${batch.length - mid}`);
        const half = Math.round((from + to) / 2);
        await checkBatch(batch.slice(0, mid), from, half);
        await checkBatch(batch.slice(mid), half, to);
        return;
      }
      if (!Array.isArray(raw?.befunde)) throw i18nError('job.error.researchCrosscheckInvalid');
      const found = validateFindings(raw.befunde, batch);
      replaceFindings(bookId, batch.map(c => c.id), found);
      findingCount += found.length;
      checkedCount += batch.length;
    };

    const batches = [];
    for (let i = 0; i < checkable.length; i += BATCH) batches.push(checkable.slice(i, i + BATCH));
    for (let b = 0; b < batches.length; b++) {
      if (signal?.aborted) throw _abort();
      const from = 10 + Math.round((b / batches.length) * 85);
      const to = 10 + Math.round(((b + 1) / batches.length) * 85);
      updateJob(jobId, { statusText: 'job.phase.researchCrosscheck', statusParams: { done: b * BATCH, total: checkable.length } });
      await checkBatch(batches[b], from, to);
    }

    logger.info(`Recherche-Abgleich: ${checkedCount} geprueft, ${findingCount} Befunde, ${noPlace.length} ohne Manuskriptstelle, ${failed.length} wegen Fehler ungeprueft`);
    completeJob(jobId, {
      ...result(checkedCount, findingCount),
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${findingCount} Befunde`);
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

module.exports = { researchCrosscheckRouter: router, runResearchCrosscheckJob, validateFindings, batchMaxTokens };

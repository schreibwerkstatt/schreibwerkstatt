'use strict';
// Seiten- und Buch-Lektorat (Job-Typen `check` / `batch-check`). Beide prüfen
// jede Seite über denselben Kern (lektorat-page.js#checkOnePage) — Kontext,
// Cache-Signatur, Prompt und History-Eintrag sind dadurch identisch. Die
// Nachbearbeitung der Findings liegt in lektorat-filter.js, die KI-Pässe
// (Split/Konsens) in lektorat-split.js. Doku: docs/lektorat.md.
const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, contentHttpError,
  jobAbortControllers,
  tps,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');
const { pageBookGuard } = require('../../lib/page-guard');
const { statusChain, doneUnchangedPageIds } = require('../../db/redaktion');
const { isJournalisticBook } = require('../../lib/buchtyp');
const { getBookSettings } = require('../../db/book-settings');
const { listChaptersForBook, pageChapters } = require('../../db/content-names');
const appSettings = require('../../lib/app-settings');
const { objektivRuns, splitEnabled } = require('./lektorat-split');
const { prepareLektoratRun, makeNeighbourLoader, loadLektoratPageList, checkOnePage, progressSincePrevious } = require('./lektorat-page');

const lektoratRouter = express.Router();

// ── Job: Seiten-Lektorat ──────────────────────────────────────────────────────
async function runCheckJob(jobId, pageId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    const run = await prepareLektoratRun(bookId, userEmail, logger);
    logger.info(`Start: Seite #${pageId}`);
    updateJob(jobId, { statusText: 'job.phase.loadingPageContent', progress: 5 });

    // Seitenliste nur für die Nachbarseiten — lokale Provider bekommen keinen
    // Nachbarkontext, dort entfällt auch der Seiten-Roundtrip.
    let pages = null;
    if (bookId && !run.local) {
      try { pages = await loadLektoratPageList(bookId); }
      catch (e) { logger.warn(`Nachbarseiten-Kontext konnte nicht geladen werden (page=${pageId}): ${e.message}`); }
    }
    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'job.phase.aiAnalyzing', progress: 10 });

    const r = await checkOnePage(run, {
      jobId, tok, pageId, pages,
      neighbourParas: makeNeighbourLoader(),
      chapterNameOf: () => pageChapters([parseInt(pageId, 10)]).get(parseInt(pageId, 10))?.chapter_name || null,
      fromPct: 10, toPct: 97,
      onCacheHit: () => {
        logger.info(`Cache-HIT (page=${pageId}) – spart Lektorat-Call.`);
        updateJob(jobId, { progress: 97 });
      },
    });
    if (r.empty) { completeJob(jobId, { empty: true }); return; }
    const { pd } = r;
    if (r.historyDedup) logger.info(`History-Dedup: identische Findings wie page_check #${r.checkId}, kein neuer Eintrag.`);
    // Vergleich mit dem Vorlauf ist Zugabe: scheitert er, bleibt das Ergebnis gültig.
    let progress = null;
    try { progress = await progressSincePrevious(pageId, userEmail, r); }
    catch (e) { logger.warn(`Fortschritts-Vergleich fehlgeschlagen (page=${pageId}): ${e.message}`); }

    completeJob(jobId, {
      fehler: r.fehler,
      szenen: r.szenen,
      stilanalyse: r.stilanalyse,
      fazit: r.fazit,
      originalHtml: r.html,
      updatedAt: pd.updated_at || null,
      pageName: pd.name,
      checkId: r.checkId,
      progress,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok), `«${pd.name}» page=${pageId}, chap=${pd.chapter_id || '-'}, ${r.fehler.length} Beanstandungen${r.historyDedup ? ' (dedup)' : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (page=${pageId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
// Ergebnis: `done` = geprüfte Seiten, `skippedEmpty` = leere Seiten (zählen für
// den Fortschritt als erledigt), `failed` = [{ id, name }] der Seiten, deren
// Prüfung scheiterte — das Frontend nennt sie, statt sie im Log zu verstecken.
// Mit `chapterId` nur die Abschnitte dieses Kapitels samt aller Unterkapitel,
// in Lesereihenfolge; Nachbarkontext bleibt buchweit (Kapitelgrenzen inklusive).
async function runBatchCheckJob(jobId, bookId, userEmail, chapterId = null, { skipFinal = false } = {}) {
  const logger = makeJobLogger(jobId);
  try {
    const run = await prepareLektoratRun(bookId, userEmail, logger);
    // Kapitelname-Map einmal pro Lauf statt pro Seite.
    const chapterNameById = Object.fromEntries(
      listChaptersForBook(parseInt(bookId, 10)).map(r => [String(r.chapter_id), r.chapter_name]));
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    let pages = await contentStore.listPages(bookId).catch(e => { throw contentHttpError(e); });
    if (chapterId != null) {
      const outline = await contentStore.bookOutline(bookId).catch(e => { throw contentHttpError(e); });
      const byId = new Map(pages.map(p => [p.id, p]));
      pages = contentStore.chapterPages(outline, chapterId).map(n => byId.get(n.id)).filter(Boolean);
    }
    // Bearbeitungsstand (docs/bearbeitungsstand.md): final markierte, seither
    // unveraenderte Abschnitte ueberspringen — der Autor hat sie abgeschlossen,
    // eine erneute Pruefung kostet nur. Seither bearbeitete laufen wieder mit.
    let skippedFinal = 0;
    if (skipFinal) {
      const chain = statusChain(isJournalisticBook(getBookSettings(bookId, userEmail)));
      const finalIds = doneUnchangedPageIds(bookId, chain);
      const before = pages.length;
      pages = pages.filter(p => !finalIds.has(p.id));
      skippedFinal = before - pages.length;
    }
    if (!pages.length) { completeJob(jobId, { empty: true, chapterId, skippedFinal }); return; }
    logger.info(`Start: ${pages.length} Seiten${chapterId != null ? ` (Kapitel ${chapterId})` : ''}${skippedFinal ? `, ${skippedFinal} final übersprungen` : ''}`);

    // Cloud-Provider verträgt parallele Calls; lokale Provider (Ollama/llama.cpp) sind
    // bereits via Mutex in lib/ai.js serialisiert – Pool=1 verhindert pile-up im aiCall.
    // Split-Modus (Cloud): jede Seite fächert in K Objektiv-Läufe + 1 Stil-Lauf auf.
    // `ai.lektorat_batch_concurrency` deckelt die gleichzeitigen CALLS, nicht die Seiten –
    // der Seiten-Pool ist der Quotient daraus (Rate-Limit-Schutz). Der Default (4) ist
    // bewusst so gewählt, dass er mit dem Split-Default noch zwei Seiten parallel zulässt;
    // wer den Regler auf die Zahl der Calls pro Seite herunterdreht, bekommt bewusst
    // einen seriellen Batch.
    const rawConcurrency = run.local ? 1 : (parseInt(appSettings.get('ai.lektorat_batch_concurrency'), 10) || 4);
    const callsPerPage = (!run.local && splitEnabled()) ? objektivRuns() + 1 : 1;
    const concurrency = Math.max(1, Math.floor(rawConcurrency / callsPerPage));
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    const neighbourParas = makeNeighbourLoader();
    // Nachbarn in Buchreihenfolge über Kapitelgrenzen; geprüft wird weiter `pages`.
    let orderedPages = null;
    if (!run.local) {
      try { orderedPages = await loadLektoratPageList(bookId); }
      catch (e) { logger.warn(`Nachbarseiten-Kontext konnte nicht geladen werden: ${e.message}`); }
    }
    const chapterNameOf = (id) => chapterNameById[String(id)] || null;
    let done = 0, skippedEmpty = 0, totalErrors = 0;
    const failed = [];

    const tick = (p) => {
      const settled = done + skippedEmpty + failed.length;
      updateJob(jobId, {
        progress: Math.round((settled / pages.length) * 95),
        statusText: 'job.phase.pageProgress',
        statusParams: { current: settled, total: pages.length, name: p.name },
      });
    };

    const processPage = async (p, i) => {
      const tag = `[${i + 1}/${pages.length}] «${p.name}» page=${p.id}`;
      try {
        // Bei Pool>1 sind feinere Pct-Ranges pro Item nicht sinnvoll (mehrere
        // Calls schreiben gleichzeitig den Job-Progress) — darum ohne fromPct/toPct.
        const r = await checkOnePage(run, {
          jobId, tok, pageId: p.id, pages: orderedPages, neighbourParas, chapterNameOf,
          onCacheHit: () => logger.info(`${tag} – Cache-HIT`),
        });
        if (r.empty) { skippedEmpty++; tick(p); return; }
        totalErrors += r.fehler.length;
        done++;
        logger.info(`${tag}, ${r.fehler.length} Beanstandungen${r.historyDedup ? ' (dedup, kein neuer Eintrag)' : ''}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`${tag} übersprungen: ${e.message}`);
        failed.push({ id: p.id, name: p.name });
      }
      tick(p);
    };

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= pages.length) return;
        if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        await processPage(pages[idx], idx);
      }
    });
    await Promise.all(workers);

    completeJob(jobId, {
      chapterId, pageCount: pages.length, done, skippedEmpty, skippedFinal, failed, totalErrors,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${done}/${pages.length} Seiten, ${skippedEmpty} leer, ${failed.length} Fehler, ${totalErrors} Beanstandungen`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
lektoratRouter.post('/check', jsonBody, (req, res) => {
  const { page_name } = req.body;
  // Buch aus der Seite, nie aus dem Body (lib/page-guard.js).
  const g = pageBookGuard(req, res, { minRole: 'lektor', pageId: req.body?.page_id ?? 0 });
  if (!g) return;
  const { pageId: page_id, bookId: book_id } = g;
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('check', page_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.checkPage';
  const labelParams = { name: page_name || `#${page_id}` };
  const jobId = createJob('check', book_id || 0, userEmail, label, labelParams, page_id);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail));
  res.json({ jobId });
});

// Optional `chapter_id`: nur dieses Kapitel (inkl. Unterkapitel). Dedup bleibt
// pro Buch — die Sidebar zeigt genau einen Serien-Lauf, ein Kapitel-Lauf und
// ein Buch-Lauf nebeneinander hätten keinen Platz und prüften doppelt.
lektoratRouter.post('/batch-check', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!guardBook(req, res, book_id, 'lektor')) return;
  let chapter = null;
  if (req.body?.chapter_id != null) {
    const chapterId = toIntId(req.body.chapter_id);
    chapter = chapterId ? listChaptersForBook(book_id).find(c => c.chapter_id === chapterId) : null;
    if (!chapter) return res.status(404).json({ error_code: 'CHAPTER_NOT_IN_BOOK' });
  }
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('batch-check', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = chapter ? 'job.label.batchCheckChapter'
    : book_name ? 'job.label.batchCheckBook' : 'job.label.batchCheck';
  const labelParams = chapter ? { name: chapter.chapter_name }
    : book_name ? { name: book_name } : null;
  const jobId = createJob('batch-check', book_id, userEmail, label, labelParams);
  const skipFinal = req.body?.skip_final === true;
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, chapter ? chapter.chapter_id : null, { skipFinal }));
  res.json({ jobId });
});

module.exports = { lektoratRouter, runCheckJob, runBatchCheckJob };

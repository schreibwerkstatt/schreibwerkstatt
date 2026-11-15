'use strict';
// Standalone-Erzählprofil-Job: rechnet nur die Phase «Erzählprofil» neu, ohne die
// volle Extraktions-Pipeline (P1–P8). Baut denselben Kontext wie job-komplett auf
// und ruft die geteilte Phase runErzaehlprofil auf. Der figNameToId-Lookup kommt aus
// dem bereits vorhandenen Figuren-Katalog (die Phase mappt nur Erzähler → figure_id,
// sie erzeugt keine Figuren). Als eigenständiger Job ist ein Fehler hier terminal.
const { db } = require('../../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, contentHttpError,
  getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers, tps, summarizeCostByPhase,
} = require('../shared');
const { makeKomplettCall } = require('./call');
const { prepareBookText } = require('./book-text');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { makePhaseTimer } = require('./utils');
const { runErzaehlprofil } = require('./phases');
const { _komplettAiOverrides, komplettTextOpts } = require('./job-shared');
const { providerClass, resolveProvider } = require('../../../lib/ai');

async function runErzaehlprofilJob(jobId, bookId, bookName, userEmail, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // Effektiven Provider binden (siehe runKomplettAnalyseJob) — sonst kappt aiCall das
  // Output-Ceiling fälschlich auf den Claude-Default.
  const effectiveProvider = provider || resolveProvider({ userEmail });
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Erzählprofil-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)} (global model=${appSettings.get(`ai.${effectiveProvider}.model`)}).`);
  }
  // `tier` (Kostenklasse für job.result.costByPhase) wie in runKomplettAnalyseJob durchreichen.
  // Geteilter Buch-Präfix → kein Schema (Cache-Regel, siehe ./call.js).
  const call = makeKomplettCall(effectiveProvider);
  const { singlePass: singlePassLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts(userEmail);
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    // Bekannte Figuren (Name → TEXT-fig_id) für den Erzähler-/Fokusfigur-Lookup.
    // saveChapterNarrativeProfiles übersetzt fig_id anschliessend nach figures.id.
    const figRows = db.prepare(
      'SELECT fig_id, name FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal, komplettTextOpts(bookId, email));

    // Buchtext-Aufbereitung: SSoT ./book-text.js (byte-identisch zur Komplettanalyse → Cache-Read).
    const { totalChars, groupOrder, groups, fullBookText } = prepareBookText(pageContents, { cloud: providerClass(effectiveProvider) === 'cloud', log });
    pt.mark('Laden');

    // Teil-Degradierungen der Phase (übersprungene Kapitel, Autoren-Befund) → Job-Result.
    const warnings = [];
    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
      singlePassLimit, totalChars, fullBookText, pageContents, groups, groupOrder,
      idMaps: { chNameToId }, prompts, sys, warnings,
    };
    const saved = await runErzaehlprofil(ctx, { figNameToId, fromPct: 55, toPct: 98 });
    pt.mark('Erzählprofil');
    log.info(`Phasen-Timing: ${pt.summary()}`);
    if (!saved) { completeJob(jobId, { empty: true, warnings }, tps(tok), 'keine Kapitel'); return; }
    const costByPhase = summarizeCostByPhase(tok);
    completeJob(jobId, {
      count: saved, warnings, tokensIn: tok.in, tokensOut: tok.out,
      ...(costByPhase ? { costByPhase } : {}),
    }, tps(tok), `${saved} Kapitel${warnings.length ? ` warn=${warnings.length}` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runErzaehlprofilJob };

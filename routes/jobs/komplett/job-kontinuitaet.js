'use strict';
// Standalone-Kontinuitätscheck (eigenständiger Job, ohne die volle Extraktions-
// Pipeline; Knopf „Nur Kontinuität prüfen" in der Kontinuitäts-Karte): Single-Pass bei
// kleinem Buch (Buchtext als gecachter System-Block wie P8), sonst Fakten-Multi-Pass mit
// Checkpoint, danach Verify-Stufe (False-Positive-Filter) und Attribut-Detektor (F4) —
// dieselben Stufen wie P8 der Komplettanalyse. Verify/F4/Anachronismus/Overrides in
// ./job-shared.
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  getBookSettings,
} = require('../../../db/schema');
const { narrativeLabels } = require('../narrative-labels');
const { activeFigureSql } = require('../../../db/figures');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  getPrompts, getBookPrompts, toSystemBlocks,
  loadOrderedBookContents, loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForAi,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers,
  tps, retryOnTransientAi, summarizeCostByPhase,
} = require('../shared');
const { makeKomplettCall, withTtl } = require('./call');
const appSettings = require('../../../lib/app-settings');
const { providerClass, resolveProvider } = require('../../../lib/ai');
const { setContext } = require('../../../lib/log-context');
const { makePhaseTimer, buildBookSystemBlockText } = require('./utils');
const { saveKontinuitaetResult } = require('./remap');
const { komplettMaxTokens } = require('./phases');
const {
  buildAnachronismusData, verifyKontinuitaetProbleme, runAttributeContradictionCheck, _komplettAiOverrides,
} = require('./job-shared');
const { COST_LABEL, costTier } = require('./cost-labels');

async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // Effektiven Provider binden (siehe runKomplettAnalyseJob) – sonst kappt aiCall das
  // Output-Ceiling fälschlich auf den Claude-Default, wenn der Job ohne expliziten Provider läuft.
  const effectiveProvider = provider || resolveProvider({ userEmail });
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Kontinuität-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)} (global model=${appSettings.get(`ai.${effectiveProvider}.model`)}).`);
  }
  // `tier` (Kostenklasse für job.result.costByPhase) wie in runKomplettAnalyseJob durchreichen.
  // Geteilter Buch-Präfix → kein Schema (Cache-Regel, siehe ./call.js).
  const call = makeKomplettCall(effectiveProvider);
  const { singlePass: singlePassLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts(userEmail);
  const sys = await getBookPrompts(bookId, email);

  try {
    let cp = loadCheckpoint('kontinuitaet', bookIdInt, email);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    // inflight wie in runKomplettAnalyseJob: parallele Verify-Calls (Promise/settledAll)
    // streamen Token gleichzeitig — ohne die inflight-Map überschreiben sich die
    // Zwischenstände in der Live-Anzeige (Endsumme bleibt korrekt, Anzeige unterzählt).
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    // Sammelt non-critical-Degradierungen (übersprungene Fakten-Kapitel) → ins Job-Result,
    // analog runKomplettAnalyseJob. Ohne dies bliebe eine Faktenlücke dem User verborgen.
    const warnings = [];

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email IS ? AND ${activeFigureSql('f')} ORDER BY f.sort_order
    `).all(bookIdInt, email);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email IS ? AND stale = 0 ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));
    // Anachronismus-Kontext (nur bei echter Zeitlinie) aus dem zuletzt gespeicherten Katalog.
    const anachronismus = buildAnachronismusData(bookIdInt, email);

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, jobAbortControllers.get(jobId)?.signal);

    // Buchtext-Preprocessing nur Cloud-Klasse (siehe runKomplettAnalyseJob).
    if (providerClass(effectiveProvider) === 'cloud') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForAi(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt.`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    // Checkpoint nur gegen DENSELBEN Buchstand fortsetzen: `nextGi`/`failedGis` sind
    // Indizes in groupOrder — nach umgestellten, neuen oder bearbeiteten Kapiteln zeigten
    // sie auf andere Kapitel, und die gesammelten Fakten wären veraltet.
    const bookSig = groupOrder.map(k => `${k}:` + groups.get(k).pages.map(p => `${p.id}@${p.updated_at || ''}`).join(',')).join('|');
    if (cp && cp.bookSig !== bookSig) {
      log.info('Checkpoint verworfen – Buch seit dem abgebrochenen Lauf verändert.');
      deleteCheckpoint('kontinuitaet', bookIdInt, email);
      cp = null;
    }
    if (cp) log.info(`Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);
    let result;
    // Multi-Pass-Fakten (Seiten-Anker + Verify-Belege); im Single-Pass null.
    let chapterFactsForSave = null;
    const isCloud = providerClass(effectiveProvider) === 'cloud';
    const verifyCtx = { call, prompts, sys, jobId, tok, bookName, groups, groupOrder, log, bookIdInt, email, pageContents, warnings };
    pt.mark('Laden');

    if (totalChars <= singlePassLimit) {
      updateJob(jobId, { progress: 60, statusText: 'job.phase.checkContinuity' });
      // Buchtext als gecachter System-Block, Auftrag im User-Prompt — wie P8. Hier der
      // einzige Leser (Verify/F4 haben eigene Systeme) → 5-min-Write statt 1h (../call.js).
      const bookText = buildSinglePassBookText(groups, groupOrder);
      const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, bookText) };
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figurenKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email)), anachronismus),
        withTtl([bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KONTINUITAET_BLOCKS)], '5m'), 60, 95, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_PROBLEME,
        costTier(COST_LABEL.kontinuitaet),
      ), { log, label: 'Kontinuität Single-Pass' });
      pt.mark('Single-Pass Check');
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen.
      // Jeder Eintrag trägt seinen Kapitel-Index `gi`: der Retry-Pass unten holt
      // Kapitel nach, und der Check braucht die Buchreihenfolge («stirbt in Kapitel 3,
      // taucht in Kapitel 7 auf»).
      let chapterFacts = cp?.chapterFacts ?? [];
      // Übersprungene Kapitel persistent merken: der Checkpoint rückt nextGi vor (sonst
      // Endlosschleife bei deterministischem Fehler), aber failedGis hält die Lücke fest,
      // damit ein Resume sie im Retry-Pass unten gezielt nachholt statt sie zu zementieren.
      let failedGis = Array.isArray(cp?.failedGis) ? [...cp.failedGis] : [];
      const startGi = cp?.nextGi ?? 0;
      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: 'job.phase.resumeFacts',
          statusParams: { current: startGi, total: groupOrder.length },
        });
      }
      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, { progress: fromPct, statusText: 'job.phase.factsInGroup', statusParams: { name: group.name, current: gi + 1, total: groupOrder.length } });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        try {
          // Retry vor dem graceful-skip: der Checkpoint rückt nach gi+1 vor, ein
          // übersprungenes Kapitel wird auch beim Resume NIE nachgeholt – ein
          // transienter Blip würde sonst dauerhaft Fakten verlieren.
          const chResult = await retryOnTransientAi(() => call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET_BLOCKS, fromPct, toPct, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_FAKTEN,
            costTier(COST_LABEL.kontinuitaet),
          ), { log, label: `Fakten «${group.name}»` });
          chapterFacts.push({ gi, kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Fakten «${group.name}» übersprungen (Retry folgt): ${e.message}`);
          if (!failedGis.includes(gi)) failedGis.push(gi);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { bookSig, chapterFacts, nextGi: gi + 1, failedGis });
      }
      // Übersprungene Kapitel gezielt nachholen — ein (transienter) Ausfall darf nicht
      // dauerhaft Fakten verlieren, auch nicht über einen Resume hinweg. Bleibt es bei einem
      // deterministischen Fehler, wird die Lücke als Warnung user-sichtbar (statt still).
      if (failedGis.length) {
        const stillFailed = [];
        for (const gi of failedGis) {
          const group = groups.get(groupOrder[gi]);
          if (!group) continue;
          const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
          try {
            const chResult = await retryOnTransientAi(() => call(jobId, tok,
              prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
              sys.SYSTEM_KONTINUITAET_BLOCKS, 86, 88, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_FAKTEN,
              costTier(COST_LABEL.kontinuitaet),
            ), { log, label: `Fakten-Retry «${group.name}»` });
            chapterFacts.push({ gi, kapitel: group.name, fakten: chResult.fakten || [] });
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            stillFailed.push(group.name);
            log.warn(`Fakten «${group.name}» auch im Retry fehlgeschlagen: ${e.message}`);
          }
        }
        failedGis = [];
        saveCheckpoint('kontinuitaet', bookIdInt, email, { bookSig, chapterFacts, nextGi: groupOrder.length, failedGis });
        if (stillFailed.length) {
          warnings.push({ key: 'job.warn.factsChapterSkipped', params: { chapters: stillFailed.join(', ') } });
        }
      }
      chapterFacts = chapterFacts.slice().sort((a, b) => (a.gi ?? 0) - (b.gi ?? 0));
      chapterFactsForSave = chapterFacts;
      pt.mark('Fakten-Extraktion');

      updateJob(jobId, { progress: 88, statusText: 'job.phase.checkContradictions' });
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt, anachronismus,
          narrativeLabels(getBookSettings(bookIdInt, email))),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 88, 95, undefined, 0.2, komplettMaxTokens(effectiveProvider), prompts.SCHEMA_KONTINUITAET_PROBLEME,
        costTier(COST_LABEL.kontinuitaet),
      ), { log, label: 'Kontinuität Check (Multi-Pass)' });
      // Fakten-basierte Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
      // Klassen-, nicht Namensfrage: der Verify-Pass braucht ein faehiges Modell, keine
      // Anthropic-API-Faehigkeit (SSoT lib/ai/config.js#providerClass).
      if (isCloud) {
        result = await verifyKontinuitaetProbleme(verifyCtx, result, 95, 96, { chapterFacts });
      }
      pt.mark('Check+Verify');
    }

    if (typeof result?.zusammenfassung === 'undefined') throw i18nError('job.error.zusammenfassungMissing');

    // F4: Attribut-Widerspruchs-Detektor inkl. „Auftritt nach dem Tod" — wie in P8
    // ergänzend und non-critical. Seine Befunde sind bereits geurteilt (keine Verify).
    if (isCloud && appSettings.get('ai.komplett.attribute_check') === true) {
      try {
        const attrFindings = await runAttributeContradictionCheck(verifyCtx, 96, 97);
        if (attrFindings.length) result = { ...result, probleme: [...(result.probleme || []), ...attrFindings] };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`Attribut-Widerspruchs-Detektor fehlgeschlagen (ignoriert): ${e.message}`);
        warnings.push({ key: 'job.warn.attributeCheckFailed' });
      }
    }

    const normalizedProbleme = saveKontinuitaetResult(bookIdInt, email, result, figNameToId, chNameToId, effectiveProvider, log,
      { pageContents, requireQuoteEvidence: !chapterFactsForSave, chapterFacts: chapterFactsForSave });
    deleteCheckpoint('kontinuitaet', bookIdInt, email);
    log.info(`Phasen-Timing: ${pt.summary()}`);
    const costByPhase = summarizeCostByPhase(tok);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      warnings,
      tokensIn: tok.in, tokensOut: tok.out,
      ...(costByPhase ? { costByPhase } : {}),
    }, tps(tok), `${normalizedProbleme.length} Probleme${warnings.length ? ` warn=${warnings.length}` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runKontinuitaetJob };

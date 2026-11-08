'use strict';
// Coverage-Self-Audit (F2, nur Cloud-Klasse): misst den Extraktions-Recall an einer
// Kapitel-Stichprobe (Grösse: utils.js#coverageSampleSize). Pro Sample bekommt das Modell den Kapiteltext + die bekannten
// Figuren-/Ort-Namen und meldet Wiedererkannte + Fehlende. Rein diagnostisch (kein
// DB-Schreibzugriff), non-critical. Läuft auf dem Extraktions-Tier.
const appSettings = require('../../../../lib/app-settings');
const { updateJob, toSystemBlocks, retryOnTransientAi, settledAll } = require('../../shared');
const { sampleChapters, coverageSampleSize, computeCoverageScore, buildBookSystemBlockText } = require('../utils');
const { komplettMaxTokens } = require('./tokens');

// Gibt `{ score, erkannt, fehlend, missingFiguren, missingOrte, sampledChapters }` oder null.
// `singlePass`: die Extraktion lief über den 1h-Buchblock (A1 hat ihn samt seinen System-
// Blöcken in den Cache geschrieben). Dann liest der Audit genau diesen Präfix und nennt nur
// das Kapitel — statt den Kapiteltext je Stichprobe ungecacht mitzuschicken und den
// Extraktions-System-Block dreimal parallel neu zu schreiben. Gleiches Tier wie A1
// (coverageTier = Extraktions-Tier), sonst bräche der Cache.
async function runCoverageAudit(ctx, figurenNames, orteNames, { singlePass = false } = {}) {
  const { jobId, bookName, call, tok, log, prompts, sys, groups, groupOrder, coverageTier } = ctx;
  const n = coverageSampleSize(appSettings.get('ai.komplett.coverage_audit_chapters'), (groupOrder || []).length);
  if (n <= 0) return null;
  const samples = sampleChapters(groups, groupOrder, n);
  if (!samples.length) return null;
  updateJob(jobId, { statusText: 'job.phase.coverageAudit' });
  const cap = komplettMaxTokens(ctx.effectiveProvider);
  const useBookBlock = singlePass && !!ctx.fullBookText;
  const system = useBookBlock
    ? [{ text: buildBookSystemBlockText(bookName, ctx.pageContents.length, ctx.fullBookText), ttl: '1h', sharedPrefix: true },
      ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')]
    : toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS);
  const results = await settledAll(samples.map(s => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildCoverageAuditPrompt(bookName, s.name, useBookBlock ? null : s.chText, figurenNames, orteNames),
    system, null, null, cap, 0.2, null,
    prompts.SCHEMA_COVERAGE_AUDIT, coverageTier,
  ), { log, label: `Coverage «${s.name}»` })),
  // Ohne Buchblock schreibt der erste Call den System-Cache, die übrigen lesen ihn.
  { concurrency: 3, warmup: !useBookBlock });
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!ok.length) { log.warn('Coverage-Audit: keine auswertbare Stichprobe.'); return null; }
  const cov = computeCoverageScore(ok);
  log.info(`Coverage-Audit: Score ${cov.score == null ? 'n/a' : cov.score} (${cov.erkannt} erkannt, ${cov.fehlend} fehlend) über ${ok.length}/${samples.length} Kapitel.`);
  // Die Namen nur im Job-Ergebnis zu tragen, reicht nicht: es lebt im Speicher und ist
  // nach dem Aufräumen weg — wer einen Lauf nachträglich prüft, hat nur das Log.
  if (cov.missingFiguren?.length) log.info(`Coverage-Audit fehlende Figuren: ${cov.missingFiguren.join(', ')}`);
  if (cov.missingOrte?.length) log.info(`Coverage-Audit fehlende Orte: ${cov.missingOrte.join(', ')}`);
  return { ...cov, sampledChapters: ok.length };
}

module.exports = { runCoverageAudit };

'use strict';
// Single-Pass-Fakten-Call (C) auswerten: Erfolg übernehmen, eine Trunkierung
// kapitelgruppenweise retten, einen Ausfall als leere Fakten + Warnung melden.
// Ausgelagert aus ../extraktion.js (LOC-Cap).
const { i18nError, settledAll, retryOnTransientAi, toSystemBlocks } = require('../../../shared');

/** Rettung für einen am Output-Deckel abgeschnittenen Single-Pass-Fakten-Call: die
 *  Kapitel in bis zu drei etwa gleich lange Gruppen teilen und je Gruppe einen C-Call
 *  gegen DENSELBEN gecachten Buchtext-Block stellen (cache_read, nur der User-Prompt
 *  unterscheidet sich). Alles oder nichts: scheitert eine Gruppe, wirft die Rettung, und
 *  der Aufrufer behandelt C als ausgefallen (die bestehenden Fakten bleiben stehen). */
async function _rescueFaktenPassSplit(ctx, { bookSystemBlock, claudeExtractCap }) {
  const { jobId, bookName, call, tok, log, prompts, sys, pageContents, groups, groupOrder, extractTier } = ctx;
  const named = (groupOrder || []).map(k => groups.get(k)).filter(g => g?.name && g.pages?.length);
  if (named.length < 2) throw i18nError('job.error.aiTruncated');
  const sizeOf = (g) => g.pages.reduce((s, p) => s + (p.text?.length || 0), 0);
  const total = named.reduce((s, g) => s + sizeOf(g), 0);
  const parts = Math.min(3, named.length);
  const target = total / parts;
  const buckets = [[]];
  let acc = 0;
  for (const g of named) {
    if (acc >= target && buckets.length < parts) { buckets.push([]); acc = 0; }
    buckets[buckets.length - 1].push(g.name);
    acc += sizeOf(g);
  }
  log.warn(`Single-Pass Fakten-Pass (C) abgeschnitten – Rettung in ${buckets.length} Kapitelgruppen.`);
  const results = await settledAll(buckets.map((names, i) => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildExtraktionFaktenPassPrompt('Gesamtbuch', bookName, pageContents.length, null, { nurKapitel: names }),
    [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS, '1h')],
    null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FAKTEN_PASS, extractTier,
  ), { log, label: `Single-Pass Fakten (C) Teil ${i + 1}/${buckets.length}` })));
  const bad = results.find(r => r.status === 'rejected');
  if (bad) throw bad.reason;
  return { fakten: results.flatMap(r => r.value?.fakten || []) };
}

/** Ergebnis des Fakten-Calls (settled) → `{ fakten, failed }`. Nicht fatal: ein
 *  gescheiterter Fakten-Call soll die teure Figuren-/Orte-Extraktion nicht verwerfen.
 *  `failed` verhindert das Einfrieren des '__singlepass__'-Caches (sonst Phantom-leere
 *  Fakten bis zur nächsten Seitenedition) und das Ersetzen des Fakten-Index mit [].
 *  AbortError bleibt fatal. */
async function resolveSinglePassFakten(ctx, faktenRes, { bookSystemBlock, claudeExtractCap }) {
  let res = faktenRes;
  if (res.status === 'rejected' && res.reason?.name !== 'AbortError' && res.reason?.message === 'job.error.aiTruncated') {
    res = await _rescueFaktenPassSplit(ctx, { bookSystemBlock, claudeExtractCap })
      .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
  }
  if (res.status === 'fulfilled') return { fakten: res.value?.fakten || [], failed: false };
  if (res.reason?.name === 'AbortError') throw res.reason;
  ctx.log.warn(`Single-Pass Fakten-Pass (C) fehlgeschlagen, Fakten leer: ${res.reason?.message}`);
  ctx.warnings?.push({ key: 'job.warn.faktenFailed' });
  return { fakten: [], failed: true };
}

module.exports = { resolveSinglePassFakten, _rescueFaktenPassSplit };

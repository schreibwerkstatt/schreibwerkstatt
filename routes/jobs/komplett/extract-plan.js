'use strict';
// Extraktions-Plan der Komplettanalyse (Phase 1): welches Tier die Extraktion fährt,
// welche Grenzen gelten, unter welcher Cache-Version und in welchen Chunks sie läuft,
// und wie der Delta-Cache-Key eines Chunks aussieht. Ein Ort für zwei Konsumenten:
//   - der Job (job-komplett.js, phases/extraktion.js, phases/extraktion/multi-pass.js),
//   - die Prognose im Start-Dialog (forecastExtractCache, über ./delta.js), die ohne
//     KI-Call sagt, wie viele Kapitel aus dem Cache kämen.
// Why: die Prognose ist nur so viel wert, wie sie die Keys des Jobs trifft. Eine
// zweite Rechnung daneben läge nach der nächsten Signatur-Änderung still daneben.
//
// Alles, was Modell oder Effort auflöst (effectiveCallSig, chunkLimitsFor), liest den
// ALS-Job-Bag — Aufrufer ausserhalb des Jobs laufen darum in withKomplettContext.

const appSettings = require('../../../lib/app-settings');
const { runWithContext, setContext } = require('../../../lib/log-context');
const { providerClass, resolveProvider } = require('../../../lib/ai');
const {
  chunkLimitsFor, resolveExtractSinglePassLimit, splitGroupsIntoChunks, pageSigSuffix,
  getPrompts, getBookPrompts, groupByChapter, cleanPageTextForAi,
} = require('../shared');
const { loadCheckpoint, loadChapterExtractCache, getBookSettings, countExtractCacheForVersion } = require('../../../db/schema');
const { komplettMaxTokens } = require('./phases/tokens');
const { extractCacheBase } = require('./signatures');
const { buildBookPagesSig, bookSettingsSigPart } = require('./utils');
const { COST_LABEL } = require('./cost-labels');
const { _komplettAiOverrides } = require('./job-shared');

// Merker «Single-Pass ist an diesem Buch am Output-Cap gerissen». Ohne ihn startet jeder
// Folgelauf A1/B/C wieder über das ganze Buch, lässt sie bis zum Cap laufen und verwirft
// sie, bevor der Multi-Pass-Fallback greift — bezahlt und weggeworfen, in jedem Lauf.
// Gilt, solange das Buch nicht deutlich kleiner geworden ist (Toleranz 10 %).
const SP_TRUNC_CP_TYPE = 'komplett-singlepass-truncated';

/** Tier der Extraktions-Calls (nur Claude: eigenes Modell + Denk-Tiefe). */
function buildExtractTier(effectiveProvider) {
  if (effectiveProvider !== 'claude') return { label: COST_LABEL.extract };
  return {
    model: String(appSettings.get('ai.claude.model.komplett.extract') || '').trim() || undefined,
    effort: String(appSettings.get('ai.claude.effort.komplett.extract') || '').trim().toLowerCase() || undefined,
    label: COST_LABEL.extract,
  };
}

// Per-Provider-Skalierung aus dessen `ai.<p>.context_window` (lib/ai.js#getContextConfigFor).
// Bei Claude 200K-Kontext ≈ 420K Zeichen Single-Pass – reicht für fast alle Bücher.
// Gegen das EIGENE Output-Cap dieser Pipeline gerechnet, nicht gegen das provider-weite:
// `komplettMaxTokens` (Cloud: das Provider-Ceiling, lokal `ai.komplett.extract_max_tokens`)
// ist das Output-Cap der Pipeline. Es wirkt nur, wenn ein Call es im `maxTokens`-Slot
// übergibt (9. Argument von `call`, Muster phases/extraktion.js) — im `expectedChars`-Slot
// ist es bloss eine Fortschritts-Schätzung, und aiCall reserviert dann das Provider-Ceiling.
// Der Wert im `maxTokens`-Slot bestimmt auch den Kontext-Preflight in aiCall.
// Mit dem provider-weiten `max_tokens_out` läge die Chunk-Grenze unter dem, was die Calls
// tatsächlich tragen — bei einem lokalen Modell zerlegt das das Buch in deutlich mehr
// Chunks als nötig (mehr Calls, mehr chunk-übergreifende Dubletten in der Konsolidierung).
/** Single-/Multi-Pass-Grenzen der Pipeline. Liest den Job-Bag (Komplett-Kontextfenster).
 *  `extractSinglePassLimit` ist die EXTRAKTIONS-Schwelle, entkoppelt von der Kontinuitäts-
 *  Schwelle (`singlePassLimit`): mit 1M-Kontext würde sonst fast jedes Buch Single-Pass
 *  extrahiert (schlechterer Long-Tail-Recall, Truncation-Risiko im Output-Cap).
 *  `ai.komplett.extract_single_pass_cap` > 0 zwingt die Extraktion in kapitelweise Chunks
 *  (Gap-Pässe + Alias-Cluster greifen), während Kontinuität/Erzählprofil weiter das ganze
 *  Buch sehen. Nur Cloud-Klasse. */
function resolveExtractLimits(effectiveProvider) {
  const isCloudModel = providerClass(effectiveProvider) === 'cloud';
  const { singlePass: singlePassLimit, perChunk: perChunkLimit } =
    chunkLimitsFor(effectiveProvider, { maxTokensOut: komplettMaxTokens(effectiveProvider) });
  const extractCapChars = isCloudModel
    ? Math.max(0, parseInt(appSettings.get('ai.komplett.extract_single_pass_cap'), 10) || 0)
    : 0;
  const extractSinglePassLimit = resolveExtractSinglePassLimit(singlePassLimit, extractCapChars);
  return { singlePassLimit, perChunkLimit, extractCapChars, extractSinglePassLimit };
}

/** Einstellungen, die den Inhalt der Extraktion verändern — darum in der Cache-Version,
 *  sonst lieferte ein Toggle bei unverändertem Text weiter den alten HIT:
 *  `completeness_passes` (zusätzliche Long-Tail-Entitäten), Szenen-Backfill (mutiert den
 *  gecachten __singlepass__-Katalog, nur Cloud). Der Coverage-Audit misst nur und gehört
 *  nicht hinein. */
function resolveExtractFlags(isCloudModel) {
  const completenessPasses = Math.max(0, Math.min(3,
    parseInt(appSettings.get('ai.komplett.completeness_passes'), 10) || 0));
  const sceneBackfillEnabled = isCloudModel && appSettings.get('ai.komplett.scene_backfill') !== false;
  const sceneBackfillMinChars = Math.max(500, parseInt(appSettings.get('ai.komplett.scene_backfill_min_chars'), 10) || 3000);
  return { completenessPasses, sceneBackfillEnabled, sceneBackfillMinChars };
}

/** Cache-Versionen: Modell + Effort des Extraktions-Tiers nach Auflösung, die System-
 *  Blöcke dieses Buchs (Buchkontext eingeschlossen) und die Extraktions-Prompt-Version
 *  (./signatures.js). `cacheVersion` (Single-Pass-Key, Checkpoint) trägt zusätzlich
 *  completeness_passes und die Single-Pass-Erweiterungen; `chunkCacheVersion` (Multi-Pass-
 *  Basis-Chunks) nicht — ein Toggle daran soll nicht alle Kapitel neu bezahlen, der
 *  :gap-Key trägt cp selbst. Details: docs/komplett.md#caching--resume. */
function extractCacheVersions({ effectiveProvider, extractTier, sys, prompts, extractCapChars, flags }) {
  const isCloudModel = providerClass(effectiveProvider) === 'cloud';
  const extractVersion = prompts.KOMPLETT_EXTRACT_VERSION || prompts.PROMPTS_VERSION || '';
  const chunkCacheVersion = extractCacheBase({ provider: effectiveProvider, tier: extractTier, sys, extractVersion });
  const singlePassAug = isCloudModel
    ? `:esp${extractCapChars}:sb${flags.sceneBackfillEnabled ? 1 : 0}:sbm${flags.sceneBackfillMinChars}`
    : '';
  const cacheVersion = `${chunkCacheVersion}:cp${flags.completenessPasses}${singlePassAug}`;
  return { chunkCacheVersion, cacheVersion };
}

/** Single- oder Multi-Pass und die Chunks dazu — die Entscheidung von runPhase1 vor jedem
 *  KI-Call. `tooDense`: Single-Pass riss zuletzt am Output-Cap → direkt Multi-Pass mit
 *  halber Chunk-Grenze. Der Truncation-Fallback eines laufenden Single-Pass ist hier nicht
 *  enthalten (er entscheidet sich erst am Call). */
function chooseExtractChunks({ effectiveProvider, groups, groupOrder, totalChars,
  singlePassLimit, extractSinglePassLimit, perChunkLimit, truncMarker }) {
  const extractLimit = extractSinglePassLimit || singlePassLimit;
  // Claude packt alles in einen Chunk (extractLimit als obere Schranke), lokale
  // Provider chunken nach `ai.<provider>.context_window`.
  const chunkLimit = effectiveProvider === 'claude' ? extractLimit : perChunkLimit;
  const primary = splitGroupsIntoChunks(groups, groupOrder, chunkLimit);
  const knownTooDense = providerClass(effectiveProvider) === 'cloud'
    && truncMarker?.provider === effectiveProvider
    && Number(truncMarker.totalChars) > 0 && totalChars >= Number(truncMarker.totalChars) * 0.9;
  if (totalChars <= extractLimit && knownTooDense) {
    const fb = splitGroupsIntoChunks(groups, groupOrder, tooDenseChunkLimit(extractLimit));
    if (fb.chunkOrder.length > 1) {
      return { mode: 'multi', tooDense: true, extractLimit, primaryChunks: primary.chunkOrder.length, ...fb };
    }
  }
  const mode = totalChars <= extractLimit ? 'single' : 'multi';
  return { mode, tooDense: false, extractLimit, primaryChunks: primary.chunkOrder.length, ...primary };
}

/** Chunk-Grenze nach einem Single-Pass-Abriss am Output-Cap. */
function tooDenseChunkLimit(extractLimit) {
  return Math.max(10000, Math.floor(extractLimit / 2));
}

/** Delta-Cache-Signatur eines Multi-Pass-Chunks. Der Kapitelname gehört hinein: er fliesst
 *  in den Prompt, steht aber nicht in page_id:updated_at — ohne ihn lieferte eine reine
 *  Umbenennung einen stale HIT mit altem Kapitelkontext. */
function chunkPagesSig(chunk, settingsSig, chunkCacheVersion) {
  return chunk.pages.map(p => `${p.id}:${p.updated_at}${pageSigSuffix(p)}`).sort().join('|')
    + `||${settingsSig}||ch:${chunk.name || ''}||${chunkCacheVersion || ''}`;
}

/** Läuft `fn` im Kontext eines Komplett-Jobs dieses Users (Profil, Komplett-Overrides) —
 *  für Aufrufer ausserhalb der Queue. */
function withKomplettContext(bookId, userEmail, fn) {
  return runWithContext({ job: 'komplett-analyse', user: userEmail || null, book: bookId }, async () => {
    const effectiveProvider = resolveProvider({ userEmail });
    const overrides = _komplettAiOverrides(effectiveProvider);
    if (overrides) setContext(overrides);
    return fn(effectiveProvider);
  });
}

/** Prognose für den Start-Dialog: wie viele Extraktions-Einheiten (Kapitel-Chunks bzw. das
 *  ganze Buch im Single-Pass) ein Lauf jetzt aus dem Delta-Cache nähme. Kein KI-Call.
 *  `contents`: loadPageContents-Ergebnis mit denselben Optionen wie im Job (wird nicht
 *  verändert). Rückgabe `{ mode, total, cached, chunks: [{ name, cached }], versionChanged }`;
 *  `versionChanged`: kein Cache-Eintrag dieses Buchs trägt die aktuelle Version — Prompts,
 *  Modell, Effort oder Buchkontext haben sich seit dem letzten Lauf geändert. */
async function forecastExtractCache(bookId, userEmail, contents) {
  const bookIdInt = parseInt(bookId, 10);
  const email = userEmail || null;
  return withKomplettContext(bookIdInt, email, async (effectiveProvider) => {
    const isCloudModel = providerClass(effectiveProvider) === 'cloud';
    const pageContents = isCloudModel
      ? contents.map(p => ({ ...p, text: cleanPageTextForAi(p.text) }))
      : contents;
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    const limits = resolveExtractLimits(effectiveProvider);
    const flags = resolveExtractFlags(isCloudModel);
    const extractTier = buildExtractTier(effectiveProvider);
    const prompts = await getPrompts(email);
    const sys = await getBookPrompts(bookIdInt, email);
    const { chunkCacheVersion, cacheVersion } = extractCacheVersions({
      effectiveProvider, extractTier, sys, prompts, extractCapChars: limits.extractCapChars, flags,
    });
    const truncMarker = loadCheckpoint(SP_TRUNC_CP_TYPE, bookIdInt, email);
    const plan = chooseExtractChunks({ effectiveProvider, groups, groupOrder, totalChars, ...limits, truncMarker });
    const versionChanged = countExtractCacheForVersion(bookIdInt, email || '', effectiveProvider,
      plan.mode === 'single' ? cacheVersion : chunkCacheVersion) === 0;

    if (plan.mode === 'single') {
      const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);
      const hit = !!loadChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, effectiveProvider);
      return { mode: 'single', total: 1, cached: hit ? 1 : 0, chunks: [], versionChanged };
    }

    const settingsSig = bookSettingsSigPart(getBookSettings(bookIdInt, email));
    const isSplit = !isCloudModel;
    const withGap = isCloudModel && flags.completenessPasses > 0;
    const has = (key, sig) => !!loadChapterExtractCache(bookIdInt, email, key, sig, effectiveProvider);
    const chunks = plan.chunkOrder.map((key) => {
      const chunk = plan.chunks.get(key);
      const sig = chunkPagesSig(chunk, settingsSig, chunkCacheVersion);
      const base = isSplit ? has(`${key}:figuren`, sig) && has(`${key}:orte`, sig) : has(key, sig);
      const gap = !withGap || has(`${key}:gap`, `${sig}||cp${flags.completenessPasses}`);
      return { name: chunk.name || '', cached: base && gap };
    });
    return {
      mode: 'multi',
      total: chunks.length,
      cached: chunks.filter(c => c.cached).length,
      chunks,
      versionChanged,
    };
  });
}

module.exports = {
  SP_TRUNC_CP_TYPE,
  buildExtractTier, resolveExtractLimits, resolveExtractFlags, extractCacheVersions,
  chooseExtractChunks, tooDenseChunkLimit, chunkPagesSig, withKomplettContext, forecastExtractCache,
};

'use strict';
// Modellstufen der Claude-Jobs. Jeder Claude-Job läuft auf einer von vier Stufen
// (lib/ai/job-tiers.js: max, strong, standard, light); welche, stellt der Admin pro
// Job ein (`ai.claude.tier.job.<typ>`, Default aus JOB_TIER_CATALOG). Ein Job, der
// im Katalog fehlt, läuft stark.
//
// «stark» ist das Instanz-Modell mit den globalen Werten (`ai.claude.model`,
// `.context_window`, `.max_tokens_out`, `.timeout_ms`) — dafür braucht es keinen
// Job-Bag. Die übrigen Stufen tragen Modell, Fenster, Output-Cap und Timeout und
// werden als Job-Bag gebunden: einmal beim Job-Start in der Queue (queue.js), damit
// JEDER Claude-Job seiner Stufe folgt, ohne dass das Job-Modul daran denken muss.
// Job-Module legen danach ihren Effort per bindJobOverride dazu (mischen, nie ersetzen).
//
// Nur Claude, und nie bei eigenem Endpunkt (dort zählt das Modell des Users, wie bei
// jedem Instanz-Override); ein eigener Claude-Zugang tauscht nur den Key. Das Modell
// gehört in die cacheVersion des Jobs — `_modelName` liest es aus dem Bag.

const appSettings = require('../../../lib/app-settings');
const { aiSetting, usesOwnEndpoint } = require('../../../lib/ai/profile');
const {
  bindJobOverride, contextSafetyMargin, _claudeModelContext, _claudeModelMaxOut,
} = require('../../../lib/ai/config');
const { TIERS, JOB_TIER_CATALOG } = require('../../../lib/ai/job-tiers');
const { getContext } = require('../../../lib/log-context');
const { _modelName } = require('./model');
const logger = require('../../../logger');

const DEFAULT_TIERS = Object.freeze(Object.fromEntries(JOB_TIER_CATALOG.map(j => [j.type, j.tier])));

function jobTier(jobType) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_TIERS, jobType)) return 'strong';
  const v = appSettings.get(`ai.claude.tier.job.${jobType}`);
  return TIERS.includes(v) ? v : DEFAULT_TIERS[jobType];
}

// Modell der Stufe «stark»: Profil > Instanz (`ai.claude.model`). Bewusst nicht
// `_modelName`, das im Job den Bag einer anderen Stufe läse.
function _strongModel(opts) {
  return aiSetting('claude', 'model', opts) || 'claude-sonnet-5-5';
}

// Konfiguration einer Stufe als Bag-Felder, oder null = läuft wie «stark» (Stufe
// «stark» selbst oder eine Stufe ohne Modell). Fenster und Output ohne eigenen Wert
// kommen aus dem Modell der Stufe, nicht vom globalen Wert — der beschreibt das
// starke Modell. Der Output wird aufs Modell-Limit geklemmt (sonst HTTP 400).
function tierSpec(tier) {
  if (tier === 'strong' || !TIERS.includes(tier)) return null;
  const model = String(appSettings.get(`ai.claude.model.tier.${tier}`) || '').trim();
  if (!model) return null;
  const num = (field) => parseInt(appSettings.get(`ai.claude.${field}.tier.${tier}`), 10) || 0;
  const modelMaxOut = _claudeModelMaxOut(model);
  const contextWindow = num('context_window') || _claudeModelContext(model);
  const maxTokensOut = Math.min(num('max_tokens_out') || modelMaxOut, modelMaxOut);
  if (maxTokensOut + contextSafetyMargin(contextWindow) >= contextWindow) {
    logger.warn(`Modellstufe ${tier}: max_tokens_out=${maxTokensOut} lässt im Fenster ${contextWindow} keinen Platz fürs Input.`);
  }
  const spec = { model, contextWindow, maxTokensOut };
  const timeoutMs = num('timeout_ms');
  if (timeoutMs) spec.timeoutMs = timeoutMs;
  return spec;
}

// Bag-Felder der Stufe eines Jobs für einen Provider, oder null (kein Claude, eigener
// Endpunkt, Stufe läuft wie «stark»). `opts` ({ userEmail }) ausserhalb des Job-Kontexts.
function jobTierSpec(jobType, provider, opts) {
  if (provider !== 'claude' || usesOwnEndpoint(opts)) return null;
  return tierSpec(jobTier(jobType));
}

// Modell eines Job-Typs bzw. Einzel-Calls ohne Nebenwirkung (Job-Anlage für
// job_runs.model, Per-Call-Modell von Extraktion und Chat-Titel).
function tierModel(jobType, provider, opts) {
  if (provider !== 'claude') return _modelName(provider, opts);
  if (usesOwnEndpoint(opts)) return _strongModel(opts);
  return tierSpec(jobTier(jobType))?.model || _strongModel(opts);
}

// Stufe des Jobs als Bag binden, gemischt in einen schon gebundenen Bag (der gewinnt:
// er ist entweder dieselbe Stufe oder eine spätere Job-Einstellung). Ruft die Queue
// beim Start jedes Jobs; ausserhalb der Queue (Prognose der Komplettanalyse) ruft es
// der Aufrufer selbst. Rückgabe: true, wenn ein Bag gebunden wurde.
function bindJobTier(jobType, provider, log = null) {
  const spec = jobTierSpec(jobType, provider);
  if (!spec) return false;
  const cur = getContext().aiJob;
  const own = cur && cur.provider === 'claude' ? cur : {};
  const missing = Object.fromEntries(Object.entries(spec).filter(([k]) => own[k] == null || own[k] === ''));
  const bag = bindJobOverride('claude', missing);
  log?.info(`Modellstufe ${jobTier(jobType)}: ${JSON.stringify(bag)}.`);
  return true;
}

// Für Job-Module: Stufe sicherstellen (idempotent zur Bindung in der Queue), optional
// weitere Bag-Felder dazulegen (`extra`, z.B. Effort) und das laufende Modell liefern —
// für cacheVersion und Log. Bei fremden Providern bleibt der Bag unberührt.
function applyTierAiOverrides(_jobId, jobType, provider, log, { extra } = {}) {
  if (provider !== 'claude') return _modelName(provider);
  bindJobTier(jobType, provider);
  if (extra && Object.keys(extra).length) bindJobOverride('claude', extra);
  const model = _modelName(provider);
  log?.info(`Modellstufe ${jobTier(jobType)}: ${model}.`);
  return model;
}

module.exports = {
  DEFAULT_TIERS, jobTier, tierSpec, jobTierSpec, tierModel, bindJobTier, applyTierAiOverrides,
};

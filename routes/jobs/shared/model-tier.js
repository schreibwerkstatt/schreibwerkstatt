'use strict';
// Modellstufen der Claude-Jobs: «stark» (globales `ai.claude.model`), «standard»
// (`ai.claude.model.tier.standard`) und «leicht» (`ai.claude.model.tier.light`).
// Welcher Job auf welcher Stufe läuft, steht ausschliesslich in JOB_TIERS; ein Job,
// der dort fehlt, läuft stark. Eine Per-Job-Einstellung (`ai.claude.model.synonym`,
// `.finetune`) schlägt die Stufe — sie bleibt die Ausnahme für einen einzelnen Job.
//
// Lektorat, die fünf Chats und die ganze Komplettanalyse-Familie (inkl. Extraktion)
// stehen bewusst NICHT hier: sie bleiben auf dem starken Modell bzw. ihren eigenen
// Override-Familien (`.lektorat`, `.bookchat`, `.komplett*`).
//
// Nur Claude, und nie bei eigenem KI-Zugang (dort zählt das Modell des Users, wie bei
// jedem Instanz-Override). Das zurückgegebene Modell gehört in die cacheVersion des
// Jobs, sonst träfe ein Haiku-Lauf die Opus-Ergebnisse und umgekehrt.

const appSettings = require('../../../lib/app-settings');
const { usesOwnAccess } = require('../../../lib/ai/profile');
const { setContext } = require('../../../lib/log-context');
const { _modelName } = require('./model');
const { setJobModel } = require('./jobs');

const JOB_TIERS = Object.freeze({
  // Leicht: kurze, mechanische Calls mit nachgelagerter Prüfung (Belegpflicht,
  // Geocoder, Katalog-Abgleich) — Tempo und Preis zählen mehr als Tiefe.
  'synonym':             'light',
  'geocode-resolve':     'light',
  'stationen-vorschlag': 'light',
  'schulweg-vorschlag':  'light',
  'research-link':       'light',
  'ideen-auto-check':    'light',
  'finetune-export':     'light',
  'figuren-naehe':       'light',
  'source-pdf-draft':    'light',
  'folder-import':       'light',
  // Kein Job-Typ, sondern ein Einzel-Call im Chat-Job (routes/jobs/chat-title.js):
  // der Titel-Einzeiler läuft per Call-Tier, die Chat-Antwort selbst bleibt stark.
  'chat-title':          'light',
  // Standard: Zusammenfassen, Herausziehen und Abgleichen über viele Abschnitte,
  // aber kein literarisches Urteil über das ganze Buch.
  'rueckblick':          'standard',
  'figur-alter':         'standard',
  'research-crosscheck': 'standard',
  'source-detect':       'standard',
  'struktur-check':      'standard',
  'book-map-label':      'standard',
});

const TIER_KEYS = Object.freeze({
  standard: 'ai.claude.model.tier.standard',
  light:    'ai.claude.model.tier.light',
});

function jobTier(jobType) {
  return JOB_TIERS[jobType] || 'strong';
}

// Modell eines Job-Typs ohne Nebenwirkung. `jobKey` = Kurzname der Per-Job-
// Einstellung (`ai.claude.model.<jobKey>`), falls der Job eine hat.
function tierModel(jobType, effectiveProvider, { jobKey } = {}) {
  const base = _modelName(effectiveProvider);
  if (effectiveProvider !== 'claude' || usesOwnAccess()) return base;
  const perJob = jobKey ? String(appSettings.get(`ai.claude.model.${jobKey}`) || '').trim() : '';
  if (perJob) return perJob;
  const key = TIER_KEYS[jobTier(jobType)];
  const tiered = key ? String(appSettings.get(key) || '').trim() : '';
  return tiered || base;
}

// Bindet das Stufen-Modell als Job-Bag (setContext ersetzt `aiJob` ganz — `extra`
// trägt darum weitere Bag-Felder wie `effort` mit) und zieht das Modell in
// job_runs nach, damit das Kosten-Ledger das tatsächlich laufende Modell bucht.
// MUSS vor `chunkLimitsFor` laufen: die Chunk-Grenzen lesen Fenster und Output-Cap
// des Bag-Modells. Rückgabe: das effektiv laufende Modell.
function applyTierAiOverrides(jobId, jobType, effectiveProvider, logger, { jobKey, extra } = {}) {
  const model = tierModel(jobType, effectiveProvider, { jobKey });
  if (effectiveProvider !== 'claude') return model;
  const bag = { provider: 'claude', ...(extra || {}) };
  if (model !== _modelName(effectiveProvider)) bag.model = model;
  if (Object.keys(bag).length > 1) {
    setContext({ aiJob: bag });
    logger?.info(`Modellstufe ${jobTier(jobType)}: ${JSON.stringify(bag)}.`);
  }
  if (jobId) setJobModel(jobId, effectiveProvider, model);
  return model;
}

module.exports = { JOB_TIERS, TIER_KEYS, jobTier, tierModel, applyTierAiOverrides };

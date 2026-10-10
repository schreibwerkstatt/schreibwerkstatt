'use strict';
// Cache-Signaturen der Komplettanalyse aus dem, was tatsächlich gesendet wird —
// nicht aus einer Liste von Einstellungen. Muster: Buchbewertung (routes/jobs/review.js).
//
// Why: jede von Hand gepflegte Liste (bookSettingsSigPart, Effort nur wenn gesetzt,
// Modell der Instanz statt des eigenen Zugangs) vergass genau die Werte, die den
// Prompt oder den Call verändern — `zeitlinie_real`, `schauplatz_land`, `is_finished`,
// der geerbte Effort. Ein Cache-HIT lieferte dann den alten Katalog, und der
// Konsolidierungs-Checkpoint übersprang den Rest. Gehasht wird darum:
//   - die System-Blöcke, wie dieses Buch sie bekommt (Buchkontext eingeschlossen),
//   - Modell und Effort, wie der Call sie AUFLÖST (Tier > Job-Bag > Profil > Instanz;
//     beim eigenen KI-Zugang ohne die Instanz-Overrides; Effort nach Modell-Klemmung).
const crypto = require('crypto');
const { _resolveClaudeModel, _claudeOutputConfigParams } = require('../../../lib/ai/config');
const { _modelName } = require('../shared/model');

// System-Blöcke der Extraktions-Calls (Single-Pass A1/B/C/E/A2, Multi-Pass, Gaps,
// Coverage). SYSTEM_FIGUREN_BLOCKS trägt A2 (Beziehungen) gegen den Buchblock.
const EXTRACT_SYS_KEYS = [
  'SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS',
  'SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS',
  'SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS',
  'SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS',
  'SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS',
  'SYSTEM_KOMPLETT_EVENTS_PASS_BLOCKS',
  'SYSTEM_FIGUREN_BLOCKS',
];
// System-Blöcke der Konsolidierung (P2/P3/P3b/P6) und der Buchkontext, den die
// Konsolidierungs-Prompts zusätzlich im User-Turn tragen.
const CONSOL_SYS_KEYS = [
  'SYSTEM_FIGUREN_BLOCKS', 'SYSTEM_ORTE_BLOCKS', 'SYSTEM_ZEITSTRAHL_BLOCKS', 'BUCH_KONTEXT',
];

function _hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

function sysSig(sys, keys) {
  return _hash(keys.map(k => [k, sys?.[k] ?? null]));
}

/** Modell + Effort, wie ein Call mit diesem Tier sie auflöst. Muss im ALS-Kontext des
 *  Jobs laufen (Job-Bag aus _komplettAiOverrides). Nicht-Claude: Modell aus dem Profil. */
function effectiveCallSig(provider, tier = null) {
  if (provider !== 'claude') return { model: _modelName(provider), effort: '' };
  const model = _resolveClaudeModel(tier?.model);
  const effort = _claudeOutputConfigParams(model, tier?.effort)?.output_config?.effort || '';
  return { model, effort };
}

/** `${model}:${extractVersion}:ee<effort>:sp<sysSig>` — Basis aller Phase-1-Caches. */
function extractCacheBase({ provider, tier, sys, extractVersion }) {
  const { model, effort } = effectiveCallSig(provider, tier);
  return `${model}:${extractVersion || ''}:ee${effort}:sp${sysSig(sys, EXTRACT_SYS_KEYS)}`;
}

/** Konsolidierungs-relevante Flags für den Konsolidierungs-Checkpoint (F5). */
function consolidationFlags({ provider, sys, matchJudge }) {
  const { model, effort } = effectiveCallSig(provider, null);
  return { model, effort, sys: sysSig(sys, CONSOL_SYS_KEYS), matchJudge: !!matchJudge };
}

module.exports = {
  EXTRACT_SYS_KEYS, CONSOL_SYS_KEYS, sysSig, effectiveCallSig, extractCacheBase, consolidationFlags,
};

'use strict';
const { aiSetting } = require('../../../lib/ai/profile');
const { _claudeUsesAdaptiveThinking, jobOverride, bindJobOverride } = require('../../../lib/ai/config');
const appSettings = require('../../../lib/app-settings');

// Modellname des effektiven Providers. Geht ueber das Profil-Overlay, NICHT direkt
// an die globalen Settings: der Name landet in jedem `cacheVersion`-String
// (`${_modelName(effectiveProvider)}:${PROMPTS_VERSION}`), und zwei Profile
// desselben Providers mit verschiedenen Modellen wuerden sich sonst Cache-Zeilen
// teilen — der `provider`-Anteil im PRIMARY KEY der Cache-Tabellen unterscheidet
// sie ja nicht. Ergebnis waere ein Treffer aus einem anderen Modell.
// `opts` ({ userEmail }) nur ausserhalb eines Job-/Request-Kontexts nötig; sonst
// liest aiSetting den User aus dem ALS-Context.
// Claude: im Job das Modell der Stufe (Job-Bag, gebunden beim Job-Start), sonst das
// Instanz-/Profil-Modell — dasselbe, was lib/ai/config.js#_resolveClaudeModel schickt.
// So trennt die cacheVersion jedes Jobs die Stufen, auch wenn der Admin einen Job
// umhängt. Die übrigen Provider lesen den Bag hier nicht: ihr Komplett-Override
// landete sonst in Cache-Versionen, die bisher ohne ihn gerechnet wurden.
function _modelName(prov, opts) {
  if (prov === 'ollama') return aiSetting('ollama', 'model', opts) || 'llama3.2';
  if (prov === 'openai-compat') return aiSetting('openai-compat', 'model', opts) || 'llama3.2';
  return jobOverride('claude', 'model') || aiSetting('claude', 'model', opts) || 'claude-sonnet-5-5';
}

// Effort-Setting eines Jobs (`ai.claude.effort.<x>`) als Job-Bag binden.
// Nur Claude und nur auf Modellen mit adaptivem Denken: ohne Feld waehlt die API den
// Modell-Default, und der liegt je nach Modell verschieden (Opus 5.5: 'medium', davor
// 'high') — ein Modellwechsel verschoebe sonst still die Denk-Tiefe des Jobs.
// Auf Sonnet 4.6 und aelter (kein Thinking) bleibt das Feld weg. Leerer Wert = kein Feld.
// Rueckgabe: `:e=<effort>` fuer die cacheVersion oder ''.
function applyEffortSetting(settingKey, effectiveProvider, logger, label) {
  if (effectiveProvider !== 'claude') return '';
  if (!_claudeUsesAdaptiveThinking(_modelName(effectiveProvider))) return '';
  const effort = String(appSettings.get(settingKey) || '').trim().toLowerCase();
  if (!effort) return '';
  bindJobOverride('claude', { effort });
  logger?.info(`${label}-Effort: ${effort}.`);
  return `:e=${effort}`;
}

// Buch- und Kapitelbewertung (`ai.claude.effort.review`).
function applyReviewAiOverrides(effectiveProvider, logger) {
  return applyEffortSetting('ai.claude.effort.review', effectiveProvider, logger, 'Review');
}

module.exports = { _modelName, applyEffortSetting, applyReviewAiOverrides };

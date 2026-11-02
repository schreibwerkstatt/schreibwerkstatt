'use strict';

const appSettings = require('../../../../lib/app-settings');
const { setContext } = require('../../../../lib/log-context');
const { usesOwnAccess } = require('../../../../lib/ai/profile');
const { _modelName } = require('../../shared');

// Modell der KI-Teile des Exports als EIN Job-Bag (setContext ersetzt `aiJob`
// ganz), wie applySynonymAiOverrides. Nur Claude: `ai.claude.model.finetune`
// erlaubt ein günstiges Modell (Haiku) neben einem schweren globalen — die
// Augment-Antworten laufen ohnehin durch Belegpflicht bzw. Fakten-Abgleich.
// Rückgabe: das effektiv laufende Modell; es gehört in jeden `versionTag` der
// Augment-Caches, sonst träfe ein Haiku-Lauf die Opus-Ergebnisse und umgekehrt.
function applyFinetuneAiOverrides(effectiveProvider, logger) {
  const baseModel = _modelName(effectiveProvider);
  if (effectiveProvider !== 'claude') return baseModel;
  // Eigener Zugang: jobOverride ignoriert das Instanz-Modell, der versionTag auch.
  const override = usesOwnAccess() ? '' : String(appSettings.get('ai.claude.model.finetune') || '').trim();
  if (!override) return baseModel;
  setContext({ aiJob: { provider: 'claude', model: override } });
  logger?.info(`Finetune-Override: Modell ${override}.`);
  return override;
}

module.exports = { applyFinetuneAiOverrides };

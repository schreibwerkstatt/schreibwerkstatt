'use strict';

const { applyTierAiOverrides } = require('../../shared/model-tier');

// Modell der KI-Teile des Exports: Stufe «leicht» bzw. `ai.claude.model.finetune`
// (shared/model-tier.js) — die Augment-Antworten laufen ohnehin durch Belegpflicht
// bzw. Fakten-Abgleich. Rückgabe: das effektiv laufende Modell; es gehört in jeden
// `versionTag` der Augment-Caches, sonst träfe ein Haiku-Lauf die Opus-Ergebnisse
// und umgekehrt.
function applyFinetuneAiOverrides(effectiveProvider, logger, jobId = null) {
  return applyTierAiOverrides(jobId, 'finetune-export', effectiveProvider, logger, { jobKey: 'finetune' });
}

module.exports = { applyFinetuneAiOverrides };

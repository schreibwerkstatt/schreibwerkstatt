'use strict';
// Verfügbarkeit des Weltfakten-Faktenchecks für einen User — EINE Quelle für drei Stellen:
//   /config                         → `komplett.factcheck` (Abschnitt sichtbar ja/nein)
//   POST /jobs/faktencheck          → Vorab-Prüfung (routes/jobs/komplett/index.js)
//   runFaktencheckJob               → nochmals beim Lauf (Setting/Provider kann sich
//                                     zwischen POST und Queue-Start ändern)
//
// Der Check braucht eine Websuche — welcher Weg gilt, entscheidet
// lib/websearch#webSearchStatus (Claude: Anthropic oder SearXNG; andere Provider mit
// Tool-Calling: nur SearXNG). Dazu der Instanz-Kill-Switch `ai.komplett.factcheck`
// (Default aus, weil Anthropic-Suchen kosten). Das Buch-Opt-in
// `weltfakten_real_pruefen` prüft die Route am Buch, nicht hier.
// Siehe docs/komplett.md („Weltfakten-Faktencheck").

const appSettings = require('./app-settings');
const { webSearchStatus } = require('./websearch');

const _BLOCKS = {
  no_tools: { status: 400, error_code: 'FACTCHECK_NO_TOOLS', i18nKey: 'job.error.factcheckNoTools' },
  off:      { status: 400, error_code: 'FACTCHECK_NO_WEBSEARCH', i18nKey: 'job.error.factcheckNoWebsearch' },
};
const _DISABLED = { status: 400, error_code: 'FACTCHECK_DISABLED', i18nKey: 'job.error.factcheckDisabled' };

/**
 * @param {string|null} userEmail
 * @returns {null | { status: number, error_code: string, i18nKey: string }}
 *   null = verfügbar. Sonst der Grund (HTTP-Status + Client-Code + Job-Fehler-Key).
 */
function factcheckGate(userEmail) {
  if (appSettings.get('ai.komplett.factcheck') !== true) return { ..._DISABLED };
  const { mode, reason } = webSearchStatus(userEmail);
  if (!mode) return { ..._BLOCKS[reason] };
  return null;
}

module.exports = { factcheckGate };

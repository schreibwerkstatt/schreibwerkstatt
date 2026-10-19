'use strict';
// Verfügbarkeit des Recherche-Chats für einen User — EINE Quelle für drei Stellen:
//   /config                       → `researchChat.enabled` (Panel sichtbar ja/nein)
//   POST /jobs/research-chat      → Vorab-Prüfung, BEVOR die User-Nachricht gespeichert wird
//   runResearchChatJob#validate   → nochmals beim Lauf (Setting/Provider kann sich
//                                   zwischen POST und Queue-Start ändern)
//
// Der Chat braucht eine Websuche: Claude über Anthropic oder SearXNG, andere
// Provider nur über SearXNG und nur mit Tool-Calling. Welcher Weg gilt,
// entscheidet lib/websearch#webSearchStatus. Dazu der Admin-Kill-Switch und
// für Claude ein API-Key. Siehe docs/recherche-chat.md.

const appSettings = require('./app-settings');
const { aiApiKey } = require('./ai/profile');
const { webSearchStatus } = require('./websearch');

// Grund aus webSearchStatus → Antwort. `claude_only` ist der Zustand, solange
// der SearXNG-Pfad nicht freigeschaltet ist (lib/websearch).
const _BLOCKS = {
  claude_only: { status: 400, error_code: 'RESEARCH_CHAT_CLAUDE_ONLY', i18nKey: 'job.error.researchChatClaudeOnly' },
  no_tools:    { status: 400, error_code: 'RESEARCH_CHAT_NO_TOOLS', i18nKey: 'job.error.researchChatNoTools' },
  off:         { status: 400, error_code: 'RESEARCH_CHAT_NO_WEBSEARCH', i18nKey: 'job.error.researchChatNoWebsearch' },
};
const _DISABLED = { status: 403, error_code: 'RESEARCH_CHAT_DISABLED', i18nKey: 'job.error.researchChatDisabled' };

/**
 * @param {string|null} userEmail
 * @returns {null | { status: number, error_code: string, i18nKey: string }}
 *   null = verfügbar. Sonst der Grund (HTTP-Status + Client-Code + Job-Fehler-Key).
 */
function researchChatGate(userEmail) {
  if (appSettings.get('research_chat.enabled') === false) return { ..._DISABLED };
  const { provider, mode, reason } = webSearchStatus(userEmail);
  if (!mode) return { ..._BLOCKS[reason] };
  // Key des Users (eigener Zugang / Profil), sonst der Instanz-Key — dieselbe
  // Aufloesung, die der Call selbst nimmt. Nur Claude: openai-compat-Endpunkte
  // laufen oft ohne Key (lokal), dort scheitert ein falscher Key erst im Call.
  if (provider === 'claude' && !String(aiApiKey('claude', { userEmail }) || '').trim()) {
    return { ..._DISABLED };
  }
  return null;
}

module.exports = { researchChatGate };

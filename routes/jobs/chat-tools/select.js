'use strict';
// Werkzeugsatz EINES Laufs — ein Weg für alle agentischen Chats (Buch, Plot,
// Ideen, Recherche): Slim- oder voller Satz (Zugriffstabelle), ohne Werkzeuge,
// deren Endpunkt fehlt oder deren Daten das Buch nicht hat (./index.js#AVAILABILITY),
// plus die Ausgabe-Werkzeuge des Chats, gemeinsam gerendert (Querverweise nur auf
// angebotene Werkzeuge). Das Ergebnis setzt ctx.offeredTools, an dem die Handler
// ihre Hinweise ausrichten (./shared.js#toolHint).

const appSettings = require('../../../lib/app-settings');
const { providerClass } = require('../../../lib/ai');
const { unavailableTools } = require('./index');

/**
 * 'full' oder 'slim'. Setting `jobs.book_chat.tool_set` (auto|slim|full) gilt für
 * alle agentischen Chats; 'auto' folgt der Provider-KLASSE — ein lokaler Endpunkt
 * hat kein Prompt-Caching und bezahlt den Werkzeug-Block jede Runde neu, und ein
 * kleineres Modell wählt aus wenigen Werkzeugen zuverlässiger.
 */
function chatToolSet(provider, userEmail) {
  const mode = String(appSettings.get('jobs.book_chat.tool_set') || 'auto').toLowerCase();
  if (mode === 'slim' || mode === 'full') return mode;
  return providerClass(provider, { userEmail }) === 'local' ? 'slim' : 'full';
}

/**
 * @param {object} p
 * @param {'book'|'plot'|'ideen'|'research'} p.chat
 * @param {object} p.prompts      Prompt-Modul (getPrompts) — buildChatToolset, chatToolNames
 * @param {string} p.provider     effektiver Provider
 * @param {string|null} p.userEmail
 * @param {object} p.ctx          Werkzeug-ctx (bookId, userEmail, sessionId?, logger) für die Verfügbarkeit
 * @param {Array<object>} [p.outputTools]  final_answer, propose_*, Web-Werkzeuge des Chats
 * @returns {{ tools: object[], toolNames: string[], toolSet: 'full'|'slim', offeredTools: Set<string>, unavailable: string[] }}
 */
function prepareChatTools({ chat, prompts, provider, userEmail, ctx, outputTools = [] }) {
  const toolSet = chatToolSet(provider, userEmail);
  const slim = toolSet === 'slim';
  const unavailable = unavailableTools(prompts.chatToolNames(chat, { slim }), ctx);
  const tools = prompts.buildChatToolset(chat, { slim, unavailable, outputTools });
  const toolNames = tools.map(t => t.name);
  return { tools, toolNames, toolSet, offeredTools: new Set(toolNames), unavailable: [...unavailable] };
}

module.exports = { prepareChatTools, chatToolSet };

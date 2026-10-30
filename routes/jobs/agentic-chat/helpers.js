'use strict';
// Hilfen des agentischen Chat-Loops (./loop.js): Modell-Fallback fürs Ledger,
// Token-Schätzung und Budget-Kürzung vor dem Synthese-Turn, Fehler-Abbildung,
// nicht ausgeführte Werkzeug-Ergebnisse, Effort pro Chat.

const appSettings = require('../../../lib/app-settings');
const { getContext, setContext } = require('../../../lib/log-context');
const { i18nError } = require('../shared');

// Provider-gerechter Model-Fallback, falls kein callAIWithTools-Result ein Model
// lieferte (z.B. wenn alle Iterationen scheiterten). Sonst würde die Zeile mit dem
// Claude-Model + Claude-Pricing persistiert, obwohl der Job unter ollama/openai-
// compat lief — Cost-Ledger (recordChatLedgerForMessage) liest provider+model direkt
// aus der chat_messages-Zeile.
function _defaultModelFor(provider) {
  if (provider === 'ollama')        return appSettings.get('ai.ollama.model') || 'llama3.2';
  if (provider === 'openai-compat') return appSettings.get('ai.openai-compat.model') || 'llama3.2';
  return appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}

// Grobe Input-Schätzung eines Calls über die serialisierte Request-Form (System +
// Werkzeugkatalog + Nachrichten) — dieselbe Heuristik wie der Preflight im
// openai-compat-Pfad. Den echten Wert meldet erst der Provider; die Schätzung
// reicht, um eine Runde, die das Fenster sprengen würde, gar nicht erst zu senden.
function _estimateTokens(systemPrompt, tools, messages, charsPerToken) {
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  return Math.ceil(JSON.stringify({ s: systemPrompt, t: tools, m: messages }).length / cpt);
}

// Vor dem Synthese-Turn: passt der Prompt nicht ins Budget, Werkzeug-Ergebnisse
// kürzen — Runde für Runde von der jüngsten zur ältesten, jede gleichmässig auf das,
// was dann noch zu viel ist (letzter Ausweg: durch eine Notiz ersetzen). Die
// jüngste Runde zuerst: nach ihr steht kein Assistant-Turn mehr, dessen Denkspur an
// den unveränderten Verlauf davor gebunden ist. Reicht das nicht, verlieren die
// Anthropic-Websuchen in Assistant-Turns ihre Trefferliste (jüngste zuerst). Die
// tool_result-Blöcke bleiben stehen — die Paarung mit den tool_use-Blöcken davor ist
// Pflicht, sonst antwortet die API mit 400; ebenso bleibt jeder
// web_search_tool_result-Block bei seinem server_tool_use, nur mit Fehler-Inhalt.
const TRIM_NOTE = ' … [gekürzt: Kontext-Budget erschöpft]';
const TRIM_MARGIN_CHARS = 2000;
const WEB_RESULT_DROPPED = { type: 'web_search_tool_result_error', error_code: 'unavailable' };
function _isToolResultTurn(m) {
  return m?.role === 'user' && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result');
}
function _shrinkRound(msg, overshootChars) {
  const blocks = msg.content;
  const total = blocks.reduce((n, b) => n + (b?.type === 'tool_result' && typeof b.content === 'string' ? b.content.length : 0), 0);
  if (!total) return null;
  const keepRatio = Math.max(0, (total - overshootChars) / total);
  let changed = false;
  const shrunk = blocks.map((b) => {
    if (b?.type !== 'tool_result' || typeof b.content !== 'string') return b;
    const keep = Math.floor(b.content.length * keepRatio);
    const content = keep >= 300 ? b.content.slice(0, keep) + TRIM_NOTE : TRIM_NOTE.trim();
    if (content.length >= b.content.length) return b;
    changed = true;
    return { ...b, content };
  });
  return changed ? { ...msg, content: shrunk } : null;
}
function _dropWebResults(msg) {
  if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) return null;
  let changed = false;
  const content = msg.content.map((b) => {
    if (b?.type !== 'web_search_tool_result' || !Array.isArray(b.content) || !b.content.length) return b;
    changed = true;
    return { ...b, content: { ...WEB_RESULT_DROPPED } };
  });
  return changed ? { ...msg, content } : null;
}
function _fitMessagesToBudget(messages, estimate, budgetTokens, charsPerToken) {
  if (!(estimate(messages) > budgetTokens)) return { messages, trimmed: false, rounds: 0, webDropped: 0 };
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  const out = messages.slice();
  let rounds = 0, webDropped = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (!_isToolResultTurn(out[i])) continue;
    const est = estimate(out);
    if (!(est > budgetTokens)) break;
    const next = _shrinkRound(out[i], (est - budgetTokens) * cpt + TRIM_MARGIN_CHARS);
    if (next) { out[i] = next; rounds++; }
  }
  for (let i = out.length - 1; i >= 0 && estimate(out) > budgetTokens; i--) {
    const next = _dropWebResults(out[i]);
    if (next) { out[i] = next; webDropped++; }
  }
  const trimmed = rounds > 0 || webDropped > 0;
  return { messages: trimmed ? out : messages, trimmed, rounds, webDropped };
}

// Request-Form des Synthese-Turns. Die gespeicherte Historie bleibt unangetastet;
// nur was an die API geht, wird angepasst:
// - Ein `server_tool_use` ohne zugehöriges `web_search_tool_result` im selben Turn
//   (pause_turn, danach Web-Deckel) fällt weg: das Server-Werkzeug setzt in der
//   Synthese nicht fort, ein offener Aufruf wäre ein ungültiger Verlauf.
// - Weicht der Präfix vom Original ab (Server-Werkzeuge entfernt, Ergebnisse
//   gekürzt, offener Aufruf entfernt), fallen ALLE thinking/redacted_thinking-
//   Blöcke weg. Die API bindet jeden zurückgespielten Denkblock an den byte-
//   gleichen Präfix (System, Werkzeuge, alle Nachrichten davor); ein geänderter
//   Präfix mit Denkblöcken ist ein 400. Erlaubt ist das Entfernen eines führenden
//   Laufs von Denkblöcken — alle zu entfernen gehört dazu.
// - Ein dadurch leerer Assistant-Turn fällt weg; danach direkt aufeinander folgende
//   user-Nachrichten werden zu einer zusammengeführt (Rollen alternieren).
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);
function _asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (content == null || content === '') return [];
  return [{ type: 'text', text: String(content) }];
}
function _synthesisRequestMessages(messages, { edited = false } = {}) {
  let removedOpen = 0;
  const step1 = messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    const answered = new Set(m.content.filter(b => b?.type === 'web_search_tool_result').map(b => b.tool_use_id));
    const content = m.content.filter((b) => {
      if (b?.type === 'server_tool_use' && !answered.has(b.id)) { removedOpen++; return false; }
      return true;
    });
    return content.length === m.content.length ? m : { ...m, content };
  });
  const strip = edited || removedOpen > 0;
  const out = [];
  let thinkingStripped = 0;
  let droppedTurn = false;
  for (const m of step1) {
    let msg = m;
    if (strip && m?.role === 'assistant' && Array.isArray(m.content)) {
      const content = m.content.filter(b => !THINKING_TYPES.has(b?.type));
      thinkingStripped += m.content.length - content.length;
      if (content.length !== m.content.length) msg = { ...m, content };
    }
    if (msg?.role === 'assistant' && Array.isArray(msg.content) && !msg.content.length) { droppedTurn = true; continue; }
    const prev = out[out.length - 1];
    // Nur dort zusammenführen, wo ein weggefallener Turn die Folge aufgebrochen hat —
    // sonst bleibt der Request byte-gleich (Präfix der Denkblöcke).
    if (droppedTurn && prev && prev.role === 'user' && msg?.role === 'user') {
      // cacheBreakpoint der früheren Nachricht entfällt bewusst: der Präfix ist
      // ohnehin ein anderer als im Cache.
      out[out.length - 1] = { role: 'user', content: [..._asBlocks(prev.content), ..._asBlocks(msg.content)] };
    } else {
      out.push(msg);
    }
    droppedTurn = false;
  }
  return { messages: strip ? out : messages, thinkingStripped, removedOpen, stripped: strip };
}

// Provider-Fehler im Synthese-Turn: eigener i18n-Key statt einer gespeicherten
// Platzhalter-Antwort («formuliere konkreter» wäre bei einer 529 eine falsche Auskunft).
// Schon i18n-keyed Fehler (Timeout, Kontext-Überlauf …) reisen unverändert weiter.
function _synthesisError(e) {
  // Überlast zuerst: sie trägt selbst schon einen Key (job.error.aiOverloaded),
  // der Synthese-spezifische Text soll ihn trotzdem ersetzen.
  if (e?.code === 'AI_OVERLOADED') {
    const err = i18nError('job.error.agentSynthesisOverloaded', { status: e.status || '–' });
    err.code = e.code;
    return err;
  }
  if (/^(job|error)\./.test(String(e?.message || ''))) return e;
  const err = i18nError('job.error.agentSynthesisFailed', { msg: String(e?.message || e).slice(0, 300) });
  if (e?.code) err.code = e.code;
  return err;
}

// Werkzeug-Ergebnis, das nicht ausgeführt wurde (kaputte Argumente, Deckel pro Runde).
// Text fürs Modell, `errorKey` für die Werkzeug-Liste im UI.
function _skipped(error, errorKey, errorParams) {
  return { error, errorKey, ...(errorParams ? { errorParams } : {}) };
}

// Serverseitiges Werkzeug (Anthropic: `{ type: 'web_search_…', name }`) statt einer
// eigenen Definition (`{ name, description, input_schema }`, optional `type: 'custom'`).
function isServerTool(t) {
  return !!t && typeof t.type === 'string' && t.type !== 'custom';
}

// Effort eines agentischen Chats (`ai.claude.effort.<chat>`) in den Job-Bag legen.
// Nur Claude; ein schon gesetzter Claude-Bag (Buch-Chat-Overrides: Modell, Fenster)
// bleibt erhalten und bekommt nur das Effort-Feld dazu.
function applyChatEffort(provider, settingKey) {
  if (provider !== 'claude' || !settingKey) return null;
  const effort = String(appSettings.get(settingKey) || '').trim();
  if (!effort) return null;
  const cur = getContext()?.aiJob;
  setContext({ aiJob: cur && cur.provider === 'claude' ? { ...cur, effort } : { provider: 'claude', effort } });
  return effort;
}

module.exports = {
  _defaultModelFor, _estimateTokens, _fitMessagesToBudget, _synthesisError, _skipped, applyChatEffort, isServerTool,
  _synthesisRequestMessages,
};

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

// Vor dem Synthese-Turn: passt der Prompt nicht ins Budget, die Ergebnisse der
// jüngsten Werkzeug-Runde gleichmässig kürzen (letzter Ausweg: durch eine Notiz
// ersetzen). Die tool_result-Blöcke bleiben stehen — die Paarung mit den tool_use-
// Blöcken davor ist Pflicht, sonst antwortet die API mit 400.
const TRIM_NOTE = ' … [gekürzt: Kontext-Budget erschöpft]';
function _fitMessagesToBudget(messages, estimate, budgetTokens, charsPerToken) {
  const est = estimate(messages);
  if (!(est > budgetTokens)) return { messages, trimmed: false };
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (messages[i]?.role === 'user' && Array.isArray(c) && c.some(b => b?.type === 'tool_result')) { idx = i; break; }
  }
  if (idx < 0) return { messages, trimmed: false };
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  const blocks = messages[idx].content;
  const total = blocks.reduce((n, b) => n + (b?.type === 'tool_result' && typeof b.content === 'string' ? b.content.length : 0), 0);
  const overshoot = (est - budgetTokens) * cpt + 2000;
  const keepRatio = total > 0 ? Math.max(0, (total - overshoot) / total) : 0;
  const shrunk = blocks.map((b) => {
    if (b?.type !== 'tool_result' || typeof b.content !== 'string') return b;
    const keep = Math.floor(b.content.length * keepRatio);
    return { ...b, content: keep >= 300 ? b.content.slice(0, keep) + TRIM_NOTE : TRIM_NOTE.trim() };
  });
  const out = messages.slice();
  out[idx] = { ...messages[idx], content: shrunk };
  return { messages: out, trimmed: true };
}

// Provider-Fehler im Synthese-Turn: eigener i18n-Key statt einer gespeicherten
// Platzhalter-Antwort («formuliere konkreter» wäre bei einer 529 eine falsche Auskunft).
// Schon i18n-keyed Fehler (Timeout, Kontext-Überlauf …) reisen unverändert weiter.
function _synthesisError(e) {
  if (/^(job|error)\./.test(String(e?.message || ''))) return e;
  if (e?.code === 'AI_OVERLOADED') {
    const err = i18nError('job.error.agentSynthesisOverloaded', { status: e.status || '–' });
    err.code = e.code;
    return err;
  }
  const err = i18nError('job.error.agentSynthesisFailed', { msg: String(e?.message || e).slice(0, 300) });
  if (e?.code) err.code = e.code;
  return err;
}

// Werkzeug-Ergebnis, das nicht ausgeführt wurde (kaputte Argumente, Deckel pro Runde).
// Text fürs Modell, `errorKey` für die Werkzeug-Liste im UI.
function _skipped(error, errorKey, errorParams) {
  return { error, errorKey, ...(errorParams ? { errorParams } : {}) };
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
  _defaultModelFor, _estimateTokens, _fitMessagesToBudget, _synthesisError, _skipped, applyChatEffort,
};

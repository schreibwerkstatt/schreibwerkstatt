// Werkzeug-Verlauf der agentischen Chats (Buch-, Recherche-, Plot-, Ideen-Chat) als
// Karten-Methoden — von makeChatMethods (chat-base.js) in jede Chat-Karte gehängt.
// Die Einträge baut chat/tool-log.js; gerendert wird über das Fragment
// chat-tool-log.html (Verlauf), chat-stop-note.html (Abbruch-Hinweis) und
// chat-run-failed.html (Teil-Verlauf eines gescheiterten Laufs an der Frage).

import { fmtTok } from '../utils.js';
import { toolLogEntries, toolLogHeading, chatStopNote } from './tool-log.js';

// Pro tool_calls-Array + Locale gemerkt (WeakMap, nicht am reaktiven msg — ein
// Schreiben im Render-Getter löste neue Effekte aus): das Template fragt den Verlauf
// mehrfach ab, ein Locale-Wechsel muss neu übersetzen.
const _cache = new WeakMap();

function _t() {
  const app = window.__app;
  return (k, prm) => app.t(k, prm);
}

export const toolLogMethods = {
  // Verlauf eines Turns (bzw. des Live-Stands / eines gescheiterten Laufs als Pseudo-Nachricht).
  _toolLog(msg) {
    const ci = msg?.context_info;
    const calls = ci?.tool_calls;
    const hasCalls = Array.isArray(calls) && calls.some(tc => tc?.name && tc.name !== 'final_answer');
    // Auch ohne Werkzeug-Runde, wenn vorab Kontext geladen wurde: dann zeigt der
    // Verlauf, dass die Antwort allein daraus entstand. Ein gescheiterter Lauf zeigt
    // auch reine Runden (Fehler in der Synthese).
    const hasRounds = msg?._failed && Array.isArray(ci?.tool_rounds) && ci.tool_rounds.length > 0;
    if (!hasCalls && !hasRounds && !(ci?.pre_context?.count > 0)) return null;
    const loc = window.__app?.$store?.shell?.uiLocale || '';
    const key = Array.isArray(calls) ? calls : ci;
    const hit = _cache.get(key);
    if (hit && hit.loc === loc) return hit.log;
    const t = _t();
    const entries = toolLogEntries(ci, t, { fmtTok });
    const log = { ...entries, heading: toolLogHeading(entries.rows, t) };
    _cache.set(key, { loc, log });
    return log;
  },

  // Live-Stand als Pseudo-Nachricht, damit dasselbe Fragment ihn rendert.
  _liveToolMsg() {
    return this._liveToolLog ? { role: 'assistant', _live: true, context_info: this._liveToolLog } : null;
  },

  // Antwort aus einem Deckel-Abbruch (Runden, Kosten, Kontext, Web-Suchen …): Hinweis.
  _chatStopNote(msg) {
    return msg?.role === 'assistant' ? chatStopNote(msg.context_info, _t()) : '';
  },

  // Gescheiterter oder abgebrochener Lauf: Teil-Verlauf hängt an der Frage
  // (`context_info.run_failed`, routes/jobs/agentic-chat/run-log.js).
  _failedRunMsg(msg) {
    const rf = msg?.role === 'user' ? msg.context_info?.run_failed : null;
    return rf && typeof rf === 'object' ? { role: 'assistant', _failed: true, context_info: rf } : null;
  },
  _failedRunText(msg) {
    const rf = msg?.context_info?.run_failed;
    if (!rf) return '';
    const t = _t();
    if (rf.cancelled) return t('chat.runCancelledLog');
    const err = rf.error ? t(rf.error, rf.errorParams || {}) : t('common.unknownError');
    return t('chat.runFailedLog', { msg: err });
  },
};

'use strict';
// Chat-Job-Typen, deren Token-Verbrauch in ZWEI Tabellen landet: job_runs
// (Lifecycle/Status, von completeJob→endJobRun) und chat_messages (Detail-Record
// mit korrektem Per-Message-Modell). chat_messages ist die SSoT fuer Chat-
// Verbrauch.
//
// Jede Token-/Kosten-Aggregation, die BEIDE Tabellen summiert (Admin-Usage,
// Daily-Usage, Budget-Gate, /metrics), MUSS diese Typen auf der job_runs-Seite
// ausschliessen — sonst wird jeder Chat-Dollar doppelt gezaehlt. Job-COUNT-
// Metriken und die Job-Detailliste duerfen die Rows behalten (kein Aggregat).
const CHAT_SOURCED_JOB_TYPES = ['chat', 'book-chat', 'research-chat', 'plot-chat', 'ideen-chat'];

// Job-Typ → `chat_sessions.kind` derselben Chat-Art. Die Chat-Auswertung im
// Admin-Usage (db/chat-quality.js) ordnet Fehlschlaege aus job_runs damit der
// Chat-Art zu, deren Antworten in chat_messages stehen. Ein Typ ohne Eintrag
// erscheint dort unter seinem rohen Typnamen.
const CHAT_JOB_KIND = { chat: 'page', 'book-chat': 'book', 'research-chat': 'research', 'plot-chat': 'plot', 'ideen-chat': 'ideen' };

// SQL-Fragment fuer eine WHERE-Clause ueber job_runs. `col` erlaubt Tabellen-
// Alias-Prefixe (z.B. 'jr.type'); Default ist die nackte Spalte `type`.
function excludeChatSourcedSql(col = 'type') {
  const list = CHAT_SOURCED_JOB_TYPES.map(t => `'${t}'`).join(', ');
  return `${col} NOT IN (${list})`;
}

module.exports = { CHAT_SOURCED_JOB_TYPES, CHAT_JOB_KIND, excludeChatSourcedSql };

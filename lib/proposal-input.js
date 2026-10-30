'use strict';
// Eingabe-Normalisierung der Chat-Vorschläge — geteilt von Plot-Chat
// (routes/jobs/plot-chat-tools.js), Ideen-Chat (routes/jobs/ideen-chat-tools.js)
// und den Ideen-Vorschlägen aus Abschnitts- und Buch-Chat
// (lib/chat-idee-proposals.js). Pure, ohne DB.

/** Getrimmter Text mit vereinheitlichten Zeilenenden, auf `max` gekürzt; '' für Nicht-Strings. */
function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/** Positive Ganzzahl (auch als Ziffern-String) oder null. */
function posInt(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { str, posInt };

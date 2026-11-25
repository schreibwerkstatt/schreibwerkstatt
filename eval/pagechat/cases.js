'use strict';
// Fallauswahl: jede User-Frage einer Abschnitts-Chat-Session (kind='page') der
// letzten `days` Tage. Ins Repo kommen nur IDs — kein Buchtext, keine Frage.
// Sortiert nach Buch und Kapitel-Session, damit aufeinanderfolgende Fälle den
// kapitelweiten Prompt-Block aus dem Cache lesen (wie mehrere Fragen am selben
// Abend auf Prod).

const Database = require('better-sqlite3');

function pickCases(dbPath, { days = 90 } = {}) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.session_id, s.book_id, s.page_id, m.created_at,
           (SELECT COUNT(*) FROM chat_messages p WHERE p.session_id = m.session_id AND p.role = 'user' AND p.id < m.id) AS turn
    FROM chat_messages m
    JOIN chat_sessions s ON s.id = m.session_id
    WHERE s.kind = 'page' AND m.role = 'user' AND s.page_id IS NOT NULL
      AND m.created_at >= datetime('now', ?)
    ORDER BY s.book_id, m.created_at
  `).all(`-${Number(days)} day`);
  db.close();
  return rows.map(r => ({
    id: `s${r.session_id}-m${r.message_id}`,
    session_id: r.session_id, message_id: r.message_id, book_id: r.book_id,
    turn: r.turn + 1,
  }));
}

module.exports = { pickCases };

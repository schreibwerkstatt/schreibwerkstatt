'use strict';
// Die Tabelle `sessions` des express-session-Stores (better-sqlite3-session-store,
// angelegt in server.js, keine Migration). `sess` ist das JSON der Sitzung; das
// Konto steht unter `$.user.email`. Keine FK-Kante auf app_users — darum faellt
// eine Sitzung beim Loeschen des Kontos nicht von selbst weg.

const { db } = require('./connection');

function _tableExists() {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
}

/** Alle gespeicherten Sitzungen eines Kontos entfernen. Liefert die Anzahl. */
function deleteSessionsForUser(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !_tableExists()) return 0;
  return db.prepare(
    "DELETE FROM sessions WHERE json_valid(sess) AND lower(json_extract(sess, '$.user.email')) = ?"
  ).run(e).changes;
}

module.exports = { deleteSessionsForUser };

'use strict';
// Lese-/Schreibpfade der Chat-Sessions (`chat_sessions`) fuer die drei Chats
// (Seiten-, Buch-, Recherche-Chat, siehe docs/chats.md). Hier liegen auch die
// Namens-JOINs auf `books`/`pages`, die Session-Listen und Job-Labels brauchen —
// Route- und Job-Handler fassen `pages`/`books` nicht selbst an.

const { db } = require('./connection');

// Schonfrist fuer den Orphan-Cleanup leerer Sessions. Ein paralleler
// /jobs/chat-Send kann gerade erst die user_msg in eine junge Session
// geschrieben haben — ohne Frist wuerde der Cleanup sie mitsamt Nachricht
// loeschen und der laufende Job an der FK des assistant-INSERTs scheitern.
const ORPHAN_GRACE_MS = 60 * 1000;

// ISO-Vergleich: `created_at` ist ISO+Z (NOW_ISO_SQL bzw. toISOString), der
// Cutoff ebenso — lexikografischer Vergleich ist damit zeitlich korrekt.
function _orphanCutoffIso(now = Date.now()) {
  return new Date(now - ORPHAN_GRACE_MS).toISOString();
}

const _stmtDelEmptyPage = db.prepare(`
  DELETE FROM chat_sessions
  WHERE page_id = ? AND user_email = ? AND kind = 'page'
    AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
`);

const _stmtDelEmptyBook = db.prepare(`
  DELETE FROM chat_sessions
  WHERE book_id = ? AND kind = ? AND user_email = ?
    AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
`);

/** Leere, aeltere Seiten-Sessions desselben Users loeschen. Liefert die Anzahl. */
function deleteEmptyPageSessions(pageId, userEmail, now = Date.now()) {
  return _stmtDelEmptyPage.run(pageId, userEmail, _orphanCutoffIso(now)).changes;
}

/** Leere, aeltere buchweite Sessions (kind 'book'/'research'/'plot'/'ideen') loeschen. */
function deleteEmptyBookSessions(bookId, kind, userEmail, now = Date.now()) {
  return _stmtDelEmptyBook.run(bookId, kind, userEmail, _orphanCutoffIso(now)).changes;
}

const _stmtInsPage = db.prepare(`
  INSERT INTO chat_sessions (book_id, page_id, user_email, created_at, last_message_at, opening_page_text)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _stmtInsBook = db.prepare(`
  INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
  VALUES (?, ?, ?, ?, ?)
`);

function insertPageSession({ bookId, pageId, userEmail, openingPageText = null }) {
  const now = new Date().toISOString();
  return _stmtInsPage.run(bookId, pageId, userEmail, now, now, openingPageText).lastInsertRowid;
}

function insertBookSession({ bookId, kind, userEmail }) {
  const now = new Date().toISOString();
  return _stmtInsBook.run(bookId, kind, userEmail, now, now).lastInsertRowid;
}

/** Buchweite Sessions (neueste zuerst), nur solche mit Nachrichten. `preview`
 *  ist die erste User-Nachricht, gekappt auf `previewChars`. */
function listBookSessions(bookId, kind, userEmail, previewChars) {
  const n = Math.max(1, parseInt(previewChars, 10) || 200);
  return db.prepare(`
    SELECT cs.id, cs.book_id, b.name AS book_name, cs.title, cs.created_at, cs.last_message_at,
           (SELECT substr(content, 1, ${n}) FROM chat_messages
             WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    LEFT JOIN books b ON b.book_id = cs.book_id
    WHERE cs.book_id = ? AND cs.kind = ? AND cs.user_email = ?
      AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
    ORDER BY cs.last_message_at DESC
  `).all(bookId, kind, userEmail);
}

// Vollständig (kein LIMIT): ein Zeilen-Deckel liesse ältere Gespräche der Seite
// unerreichbar in der DB liegen. Der Antwort-Umfang bleibt über den gekappten
// `preview` begrenzt (wie listBookSessions).
const _stmtListPage = db.prepare(`
  SELECT cs.id, cs.book_id, cs.page_id, p.page_name, cs.title, cs.created_at, cs.last_message_at,
         (SELECT substr(content, 1, ?) FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
  FROM chat_sessions cs
  LEFT JOIN pages p ON p.page_id = cs.page_id
  WHERE cs.page_id = ? AND cs.user_email = ?
    AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
  ORDER BY cs.last_message_at DESC
`);

function listPageSessions(pageId, userEmail, previewChars = 200) {
  const n = Math.max(1, parseInt(previewChars, 10) || 200);
  return _stmtListPage.all(n, pageId, userEmail);
}

// Session fuer die Detail-Ansicht. `opening_page_text` bleibt serverseitig: der
// Snapshot ist Prompt-Material des Seiten-Chat-Jobs, das Frontend braucht ihn nicht.
const _stmtGetOwned = db.prepare(`
  SELECT cs.id, cs.book_id, cs.kind, cs.page_id, cs.user_email, cs.title,
         cs.created_at, cs.last_message_at, p.page_name
  FROM chat_sessions cs
  LEFT JOIN pages p ON p.page_id = cs.page_id
  WHERE cs.id = ? AND cs.user_email = ?
`);

function getOwnedSession(id, userEmail) {
  return _stmtGetOwned.get(id, userEmail) || null;
}

// Session + Namen fuer das Job-Label des POST-Handlers. `kind` filtert, damit
// eine Session nicht unter dem Job-Typ eines anderen Chats laeuft.
const _stmtForJob = db.prepare(`
  SELECT cs.id, cs.book_id, cs.page_id, cs.kind, p.page_name, b.name AS book_name
  FROM chat_sessions cs
  LEFT JOIN books b ON b.book_id = cs.book_id
  LEFT JOIN pages p ON p.page_id = cs.page_id
  WHERE cs.id = ? AND cs.user_email = ?
`);

function getSessionForJob(id, userEmail) {
  return _stmtForJob.get(id, userEmail) || null;
}

// Volle Session-Row fuer den Seiten-Chat-Job (inkl. opening_page_text).
const _stmtFull = db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_email = ?');

function getSessionRow(id, userEmail) {
  return _stmtFull.get(id, userEmail) || null;
}

// Volle Session-Row + Buchname für die buchweiten Chat-Jobs (Buch-/Recherche-Chat).
// `kind` optional: gesetzt, filtert die Session-Art mit.
const _stmtWithBookName = db.prepare(`
  SELECT cs.*, b.name AS book_name FROM chat_sessions cs
  LEFT JOIN books b ON b.book_id = cs.book_id
  WHERE cs.id = ? AND cs.user_email = ? AND (? IS NULL OR cs.kind = ?)
`);

function getSessionWithBookName(id, userEmail, kind = null) {
  return _stmtWithBookName.get(id, userEmail, kind, kind) || null;
}

module.exports = {
  ORPHAN_GRACE_MS,
  deleteEmptyPageSessions,
  deleteEmptyBookSessions,
  insertPageSession,
  insertBookSession,
  listBookSessions,
  listPageSessions,
  getOwnedSession,
  getSessionForJob,
  getSessionRow,
  getSessionWithBookName,
};

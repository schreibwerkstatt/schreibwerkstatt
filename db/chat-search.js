'use strict';
// Lesepfade der Suche im Chat-Verlauf (docs/chats.md#suche-im-verlauf) plus die
// Schreibpfade des Vektor-Index `chat_semantic_chunks`.
//
// Zwei Indexe über dieselben Nachrichten:
//   - chat_messages_fts (FTS5, External Content) — gepflegt per Trigger aus
//     Migration 324, hier nur gelesen.
//   - chat_semantic_chunks — Vektoren je Gesprächs-RUNDE (letzte User-Frage vor
//     der Antwort + Antwort), verankert an der Antwort. Geschrieben vom Job
//     routes/jobs/chat-embed-index.js.
//
// Scope jeder Suche: EIN Buch, EIN User, gewählte Session-Arten. Chats gehören
// dem User, der sie geführt hat — ein Mitautor findet sie nie, auch nicht über
// das Buch-Chat-Werkzeug. Der Scope-Filter steht darum im SQL, nicht danach.
//
// Der JOIN auf `pages` (Abschnittsname der Treffer) ist der sanktionierte Fall der
// Content-Store-Regel: abgeleitete Tabelle, Name zur Lesezeit, eigenes db/-Modul.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { vectorToBlob, blobToVector, cosineSim } = require('../lib/embed-chunk');

// Session-Arten, deren Verlauf durchsuchbar ist (Abschnitts- und Buch-Chat).
const SEARCHABLE_KINDS = ['page', 'book'];

// Leere Antworten und solche, die nur ein i18n-Fallback-Marker sind (`__i18n:…__`),
// tragen keinen Gesprächsinhalt — sie werden nicht vektorisiert. Gleiche Bedingung
// für die Kandidatenliste des Jobs und die Pending-Zählung, sonst blieben sie ewig
// offen und jede Suche stiesse einen Index-Lauf an.
const _INDEXABLE = `trim(a.content) <> '' AND a.content NOT LIKE '\\_\\_i18n:%' ESCAPE '\\'`;

// Scope → WHERE-Teil über `s` (chat_sessions) + Parameter.
function _scopeSql({ bookId, userEmail, kinds, pageId = null, excludeSessionId = null }) {
  const ks = (kinds || SEARCHABLE_KINDS).filter(k => SEARCHABLE_KINDS.includes(k));
  if (!ks.length) return null;
  const parts = ['s.book_id = ?', 's.user_email = ?', `s.kind IN (${ks.map(() => '?').join(',')})`];
  const args = [bookId, userEmail, ...ks];
  if (pageId) { parts.push('s.page_id = ?'); args.push(pageId); }
  if (excludeSessionId) { parts.push('s.id <> ?'); args.push(excludeSessionId); }
  return { where: parts.join(' AND '), args };
}

// Runde einer Nachricht: die Antwort selbst bzw. bei einer User-Nachricht die
// nächste Antwort derselben Session (null, wenn keine kam). Reihenfolge über die
// id — Nachrichten werden in Gesprächsreihenfolge eingefügt.
const _ROUND_ID_SQL = `CASE WHEN m.role = 'assistant' THEN m.id ELSE (
  SELECT a.id FROM chat_messages a
   WHERE a.session_id = m.session_id AND a.role = 'assistant' AND a.id > m.id
   ORDER BY a.id LIMIT 1) END`;

const SNIP_OPEN = '\u0001';
const SNIP_CLOSE = '\u0002';

/**
 * Volltext-Treffer (bm25-Reihenfolge) im Scope. `match` ist ein fertiger
 * FTS5-Ausdruck (lib/search.js#buildMatchQuery). Rückgabe:
 * [{ message_id, session_id, round_id|null, role, snippet }] — `snippet` roh mit
 * den Sentinels SNIP_OPEN/SNIP_CLOSE um die Fundstellen (Escape beim Aufrufer).
 */
function ftsSearch(match, scope, { limit = 60 } = {}) {
  const sc = _scopeSql(scope);
  if (!sc || !match) return [];
  return db.prepare(`
    SELECT m.id AS message_id, m.session_id, m.role, ${_ROUND_ID_SQL} AS round_id,
           snippet(chat_messages_fts, 0, '${SNIP_OPEN}', '${SNIP_CLOSE}', '…', 24) AS snippet
      FROM chat_messages_fts
      JOIN chat_messages m ON m.id = chat_messages_fts.rowid
      JOIN chat_sessions s ON s.id = m.session_id
     WHERE chat_messages_fts MATCH ? AND ${sc.where}
     ORDER BY bm25(chat_messages_fts)
     LIMIT ?
  `).all(match, ...sc.args, limit);
}

/**
 * Semantische Treffer im Scope gegen queryVec: bester Chunk je Runde, Cosinus
 * absteigend, ab minScore, höchstens topK. Linearer Scan — der Verlauf eines
 * Users in einem Buch sind Hunderte bis wenige Tausend Chunks.
 * Rückgabe: [{ round_id, session_id, chunk_ix, score, text }].
 */
function semanticSearch(scope, model, queryVec, { topK = 60, minScore = 0 } = {}) {
  const sc = _scopeSql(scope);
  if (!sc) return [];
  const rows = db.prepare(`
    SELECT c.id AS cid, c.message_id, c.chunk_ix, c.vector, m.session_id
      FROM chat_semantic_chunks c
      JOIN chat_messages m ON m.id = c.message_id
      JOIN chat_sessions s ON s.id = m.session_id
     WHERE c.model = ? AND ${sc.where}
  `).all(model, ...sc.args);
  const best = new Map(); // message_id → Treffer
  for (const r of rows) {
    const score = cosineSim(queryVec, blobToVector(r.vector));
    if (!Number.isFinite(score) || score < minScore) continue;
    const cur = best.get(r.message_id);
    if (!cur || score > cur.score) {
      best.set(r.message_id, { round_id: r.message_id, session_id: r.session_id, chunk_ix: r.chunk_ix, cid: r.cid, score });
    }
  }
  const picked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  const selText = db.prepare('SELECT text FROM chat_semantic_chunks WHERE id = ?');
  return picked.map(({ cid, ...h }) => ({ ...h, text: selText.get(cid)?.text ?? '' }));
}

/**
 * Anzeige-Daten der Treffer-Nachrichten: Session-Art, Abschnitt, Titel/Vorschau,
 * Zeitpunkt. Map message_id → Zeile. Nur Nachrichten im Scope (zweite Sperre
 * neben den Suchpfaden).
 */
function messageMeta(messageIds, scope, previewChars = 120) {
  const ids = [...new Set(messageIds.filter(Number.isInteger))];
  const sc = _scopeSql(scope);
  if (!ids.length || !sc) return new Map();
  const n = Math.max(1, parseInt(previewChars, 10) || 120);
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.role, m.created_at, m.session_id,
           s.kind, s.page_id, p.page_name, s.title,
           (SELECT substr(content, 1, ${n}) FROM chat_messages
             WHERE session_id = s.id ORDER BY created_at ASC LIMIT 1) AS preview
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      LEFT JOIN pages p ON p.page_id = s.page_id
     WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${sc.where}
  `).all(...ids, ...sc.args);
  return new Map(rows.map(r => [r.message_id, r]));
}

// ── Vektor-Index (Schreibseite, nur der Index-Job) ─────────────────────────────

/**
 * Antworten eines Buchs ohne Chunks unter `model` (alle User — der Job ist ein
 * System-Job pro Buch), samt der Frage ihrer Runde. Seitenweise über `afterId`,
 * damit ein grosser Verlauf nicht am Stück im Job-Speicher liegt.
 * Rückgabe: [{ id, content, question }].
 */
function listUnindexedRounds(bookId, model, { afterId = 0, limit = 200 } = {}) {
  return db.prepare(`
    SELECT a.id, a.content,
           (SELECT u.content FROM chat_messages u
             WHERE u.session_id = a.session_id AND u.role = 'user' AND u.id < a.id
             ORDER BY u.id DESC LIMIT 1) AS question
      FROM chat_messages a
      JOIN chat_sessions s ON s.id = a.session_id
     WHERE s.book_id = ? AND s.kind IN (${SEARCHABLE_KINDS.map(() => '?').join(',')})
       AND a.role = 'assistant' AND a.id > ? AND ${_INDEXABLE}
       AND NOT EXISTS (SELECT 1 FROM chat_semantic_chunks c WHERE c.message_id = a.id AND c.model = ?)
     ORDER BY a.id
     LIMIT ?
  `).all(bookId, ...SEARCHABLE_KINDS, afterId, model, limit);
}

/** Zahl der noch nicht vektorisierten Runden eines Buchs unter `model`. */
function countUnindexedRounds(bookId, model) {
  return db.prepare(`
    SELECT COUNT(*) AS n
      FROM chat_messages a
      JOIN chat_sessions s ON s.id = a.session_id
     WHERE s.book_id = ? AND s.kind IN (${SEARCHABLE_KINDS.map(() => '?').join(',')})
       AND a.role = 'assistant' AND ${_INDEXABLE}
       AND NOT EXISTS (SELECT 1 FROM chat_semantic_chunks c WHERE c.message_id = a.id AND c.model = ?)
  `).get(bookId, ...SEARCHABLE_KINDS, model).n;
}

/** Bücher mit mindestens einer noch nicht vektorisierten Runde (Nacht-Cron). */
function booksWithUnindexedRounds(model) {
  return db.prepare(`
    SELECT DISTINCT s.book_id
      FROM chat_messages a
      JOIN chat_sessions s ON s.id = a.session_id
     WHERE s.kind IN (${SEARCHABLE_KINDS.map(() => '?').join(',')})
       AND a.role = 'assistant' AND ${_INDEXABLE}
       AND NOT EXISTS (SELECT 1 FROM chat_semantic_chunks c WHERE c.message_id = a.id AND c.model = ?)
  `).all(...SEARCHABLE_KINDS, model).map(r => r.book_id);
}

// Chunk-Satz einer Runde atomar ersetzen. Liefert false, wenn die Antwort
// inzwischen gelöscht wurde (Session gelöscht, während der Job embeddete) — der
// FK schlüge sonst fehl und risse den Lauf mit. Statements erst beim Aufruf
// vorbereiten: das Modul darf geladen werden, bevor Migration 324 lief.
const _replaceTx = db.transaction((messageId, model, dim, rows) => {
  if (!db.prepare('SELECT 1 FROM chat_messages WHERE id = ?').get(messageId)) return false;
  db.prepare('DELETE FROM chat_semantic_chunks WHERE message_id = ? AND model = ?').run(messageId, model);
  const ins = db.prepare(`
    INSERT INTO chat_semantic_chunks (message_id, chunk_ix, content_hash, model, dim, vector, text, created_at)
    VALUES (@message_id, @chunk_ix, @content_hash, @model, @dim, @vector, @text, ${NOW_ISO_SQL})
  `);
  for (const row of rows) {
    ins.run({
      message_id: messageId, chunk_ix: row.chunk_ix, content_hash: row.content_hash,
      model, dim, vector: vectorToBlob(row.vector), text: row.text,
    });
  }
  return true;
});
function replaceRoundChunks(messageId, model, dim, rows) {
  return _replaceTx(messageId, model, dim, rows || []);
}

/** Chunks fremder Modelle eines Buchs löschen (nach einem Modellwechsel Ballast). */
function clearForeignModels(bookId, model) {
  return db.prepare(`
    DELETE FROM chat_semantic_chunks
     WHERE model <> ? AND message_id IN (
       SELECT m.id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.book_id = ?)
  `).run(model, bookId).changes;
}

module.exports = {
  SEARCHABLE_KINDS, SNIP_OPEN, SNIP_CLOSE,
  ftsSearch, semanticSearch, messageMeta,
  listUnindexedRounds, countUnindexedRounds, booksWithUnindexedRounds,
  replaceRoundChunks, clearForeignModels,
};

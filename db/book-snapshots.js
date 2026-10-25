'use strict';

// Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3").
// Selbsttragende Momentaufnahme eines Buchs — content_json haelt Tree + Seiten-
// HTML inline (buildBookJson-Format), extras_json optional Analyse/Lektorat.
// Sparse + user-initiiert + ohne Pruning (Gegenstueck zu page_revisions).
//
//   createSnapshot(payload)        → { id, seq }
//   listSnapshots(bookId)          → Meta-Zeilen (ohne content_json/extras_json)
//   getSnapshot(bookId, id)        → Vollzeile inkl. content_json/extras_json
//   getSnapshotView(bookId, id)    → wie getSnapshot, aber ohne extras_json
//   getSnapshotMeta(bookId, id)    → nur Meta-Spalten (kein JSON-Blob)
//   getBaselineSnapshot(bookId)    → Fassung, deren Stand das Buch zuletzt hatte
//   markRestored(bookId, id)       → restored_at = jetzt
//   deleteSnapshot(bookId, id)     → boolean (true = geloescht)
//   countSnapshots(bookId)         → number
//   setPublished(bookId, id, on)   → boolean (true = Zeile getroffen)
//
// `kind`: 'manual' (vom User gespeichert), 'auto_backup' (Sicherung vor einem
// Restore), 'auto_finish' (beim Fertig-Markieren).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Naechste fortlaufende Fassungsnummer pro Buch (1-basiert, monoton — Loeschungen
// recyceln keine Nummer, damit „Fassung 3" stabil bleibt).
function _nextSeq(bookId) {
  const row = db.prepare('SELECT MAX(seq) AS maxSeq FROM book_snapshots WHERE book_id = ?').get(bookId);
  return (row && row.maxSeq ? row.maxSeq : 0) + 1;
}

function createSnapshot({
  bookId, kind = 'manual', label = null, description = null,
  contentJson, extrasJson = null, extrasSummary = null, publicationJson = null,
  chars = 0, words = 0, pages = 0, chapters = 0,
  userEmail = null, lektoratMetrics = null,
}) {
  const seq = _nextSeq(bookId);
  const res = db.prepare(`
    INSERT INTO book_snapshots
      (book_id, seq, kind, label, description, content_json, extras_json, extras_summary, publication_json,
       chars, words, pages, chapters, user_email, lektorat_metrics, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ${NOW_ISO_SQL})
  `).run(
    bookId, seq, kind, label, description, contentJson, extrasJson, extrasSummary, publicationJson,
    chars, words, pages, chapters, userEmail, lektoratMetrics,
  );
  return { id: res.lastInsertRowid, seq };
}

// Liste fuer die Karte: bewusst OHNE content_json/extras_json (koennen MB gross
// sein). DESC nach created_at (juengste Fassung zuerst). `has_extras` als Flag.
// `size_bytes` = Speicherbedarf der Fassung; octet_length liest dafuer nur den
// Zellen-Header, nicht den (MB-grossen) Inhalt — length() wuerde ihn dekodieren.
function listSnapshots(bookId) {
  return db.prepare(`
    SELECT id, book_id, seq, kind, label, description,
           chars, words, pages, chapters, user_email, created_at, published_at, restored_at,
           (extras_json IS NOT NULL) AS has_extras,
           (publication_json IS NOT NULL) AS has_publication,
           octet_length(content_json) + COALESCE(octet_length(extras_json), 0)
             + COALESCE(octet_length(publication_json), 0) AS size_bytes
    FROM book_snapshots
    WHERE book_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(bookId);
}

// Vollzeile inkl. content_json (+ extras_json). Book-scoped, damit ein Snapshot
// nie ueber Buchgrenzen hinweg gelesen wird.
function getSnapshot(bookId, id) {
  return db.prepare('SELECT * FROM book_snapshots WHERE id = ? AND book_id = ?').get(id, bookId) || null;
}

const META_COLS = `id, book_id, seq, kind, label, description, chars, words, pages, chapters,
  user_email, created_at, published_at, restored_at`;

// Fuer Reader/Vergleich: alles ausser dem MB-grossen extras_json (dessen
// Zaehl-Uebersicht steht vorberechnet in extras_summary).
function getSnapshotView(bookId, id) {
  return db.prepare(`
    SELECT ${META_COLS}, content_json, publication_json, extras_summary,
           (extras_json IS NOT NULL) AS has_extras
    FROM book_snapshots WHERE id = ? AND book_id = ?
  `).get(id, bookId) || null;
}

function getSnapshotMeta(bookId, id) {
  return db.prepare(`SELECT ${META_COLS} FROM book_snapshots WHERE id = ? AND book_id = ?`).get(id, bookId) || null;
}

// Nachfuellen der Zaehl-Uebersicht fuer Fassungen von vor Migration 335.
function getExtrasJson(bookId, id) {
  const row = db.prepare('SELECT extras_json FROM book_snapshots WHERE id = ? AND book_id = ?').get(id, bookId);
  return row ? row.extras_json : null;
}

function setExtrasSummary(bookId, id, summaryJson) {
  db.prepare('UPDATE book_snapshots SET extras_summary = ? WHERE id = ? AND book_id = ?').run(summaryJson, id, bookId);
}

// Vergleichsbasis fuer Drift-Check und Dedup: die Fassung, deren Stand das Buch
// zuletzt hatte — juengstes von created_at (angelegt) und restored_at (Buch auf
// sie zurueckgesetzt). Auto-Sicherungen zaehlen nur, wenn auf sie zurueckgesetzt
// wurde: sie halten den Stand VOR einem Restore fest, nicht den danach. Gibt es
// nur Sicherungen, faellt die Wahl auf die juengste Zeile ueberhaupt.
// Vollzeile inkl. content_json/publication_json (MB) — nur serverseitig.
function getBaselineSnapshot(bookId) {
  return db.prepare(`
    SELECT * FROM book_snapshots
    WHERE book_id = ? AND (kind != 'auto_backup' OR restored_at IS NOT NULL)
    ORDER BY COALESCE(restored_at, created_at) DESC, id DESC LIMIT 1
  `).get(bookId) || db.prepare(`
    SELECT * FROM book_snapshots WHERE book_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(bookId) || null;
}

// Das Buch wurde auf diese Fassung zurueckgesetzt → sie ist ab jetzt die Baseline.
function markRestored(bookId, id) {
  db.prepare(`UPDATE book_snapshots SET restored_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ?`).run(id, bookId);
}

function deleteSnapshot(bookId, id) {
  const res = db.prepare('DELETE FROM book_snapshots WHERE id = ? AND book_id = ?').run(id, bookId);
  return res.changes > 0;
}

function countSnapshots(bookId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM book_snapshots WHERE book_id = ?').get(bookId);
  return row ? row.n : 0;
}

// Fassung als veroeffentlicht markieren (published_at = jetzt) bzw. Markierung
// entfernen (NULL). Mehrere Fassungen duerfen gleichzeitig markiert sein — eine
// pro Auflage. Book-scoped. Liefert true, wenn eine Zeile getroffen wurde.
// Erneutes Markieren behaelt das erste Datum (COALESCE): es ist das Datum der Auflage.
function setPublished(bookId, id, published) {
  const res = published
    ? db.prepare(`UPDATE book_snapshots SET published_at = COALESCE(published_at, ${NOW_ISO_SQL}) WHERE id = ? AND book_id = ?`).run(id, bookId)
    : db.prepare('UPDATE book_snapshots SET published_at = NULL WHERE id = ? AND book_id = ?').run(id, bookId);
  return res.changes > 0;
}

// Fehlerdichte-Trend: die Fassungen des Buchs mit ihrer verdichteten Lektorat-
// Kennzahl (lektorat_metrics), aufsteigend nach seq (Meilenstein-Reihenfolge).
// Nur Meta + Wörter-Nenner + Metrics-JSON — kein content_json/extras_json.
function listLektoratTrend(bookId) {
  return db.prepare(`
    SELECT id, seq, label, words, created_at, published_at, lektorat_metrics
    FROM book_snapshots
    WHERE book_id = ?
    ORDER BY seq ASC
  `).all(bookId);
}

module.exports = {
  createSnapshot, listSnapshots, getSnapshot, getSnapshotView, getSnapshotMeta,
  getExtrasJson, setExtrasSummary, getBaselineSnapshot, markRestored,
  deleteSnapshot, countSnapshots, setPublished, listLektoratTrend,
};

'use strict';
// Fine-Tuning-Exporte (Migration 0350): Verlauf der erzeugten Trainingssets je
// Buch + User. Behalten werden die letzten KEEP_EXPORTS Sets, ältere fallen beim
// Speichern weg. Die Dateien liegen gzip-komprimiert (`data_gz`, JSONL schrumpft
// etwa um Faktor fünf); `bytes` ist die entpackte Grösse. Die Nutzdaten gehen
// NICHT in job.result, weil der generische Status-GET (/jobs/:id) die ganze
// result-Struktur serialisiert — bei einem grossen Buch Megabytes pro Poll.
//
// `fingerprint` hält den Buchstand fest, aus dem das Set entstand (Reihenfolge,
// Kapitel und `updated_at` jedes Abschnitts). Weicht der aktuelle Stand ab,
// zeigt die Karte das Set als veraltet; neu generiert wird nur auf Klick.

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { db } = require('./connection');
require('./migrations');
const { requireUserEmail } = require('./write-helpers');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const KEEP_EXPORTS = 5;
const FINETUNE_FILE_KINDS = ['train', 'val', 'all', 'eval', 'val-facts', 'val-writing', 'val-persona', 'val-refusal', 'val-editor'];

// Pages aus loadOrderedBookContents (Lesereihenfolge, ohne ausgeschlossene Kapitel).
function bookFingerprint(pages) {
  return crypto.createHash('sha1')
    .update(pages.map(p => `${p.id}:${p.chapter_id ?? ''}:${p.updated_at || ''}`).join('|'))
    .digest('hex');
}

function _row(r) {
  if (!r) return null;
  let stats = {};
  try { stats = JSON.parse(r.stats_json); } catch { /* leere Statistik */ }
  return { id: r.id, createdAt: r.created_at, fingerprint: r.fingerprint, stats };
}

// Neuestes zuerst.
function listFinetuneExports(bookId, userEmail) {
  return db.prepare(`SELECT id, created_at, fingerprint, stats_json FROM finetune_exports
                     WHERE book_id = ? AND user_email = ? ORDER BY created_at DESC, id DESC`)
    .all(bookId, userEmail).map(_row);
}

// Ohne `id` das neueste Set.
function getFinetuneExport(bookId, userEmail, id) {
  if (id == null) return listFinetuneExports(bookId, userEmail)[0] || null;
  return _row(db.prepare(`SELECT id, created_at, fingerprint, stats_json FROM finetune_exports
                          WHERE id = ? AND book_id = ? AND user_email = ?`).get(id, bookId, userEmail));
}

// Entpackte Datei eines Sets, oder null, wenn die Art leer war.
async function readFinetuneFile(exportId, kind) {
  const r = db.prepare('SELECT data_gz FROM finetune_export_files WHERE export_id = ? AND kind = ?').get(exportId, kind);
  return r ? gunzip(r.data_gz) : null;
}

function deleteFinetuneExport(bookId, userEmail, id) {
  return db.prepare('DELETE FROM finetune_exports WHERE id = ? AND book_id = ? AND user_email = ?')
    .run(id, bookId, userEmail).changes > 0;
}

// `files`: { train, val, all, eval, 'val-facts', … } als JSONL-Strings; leere
// Arten werden nicht gespeichert. Komprimiert wird vor der Transaktion (async,
// blockiert den Event-Loop nicht), geschrieben wird in einer.
async function saveFinetuneExport(bookId, userEmail, { createdAt, fingerprint, stats, files }) {
  requireUserEmail(userEmail, 'saveFinetuneExport');
  const packed = [];
  for (const kind of FINETUNE_FILE_KINDS) {
    const text = files[kind];
    if (!text) continue;
    const buf = Buffer.from(text, 'utf8');
    packed.push([kind, await gzip(buf), buf.length]);
  }
  return db.transaction(() => {
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO finetune_exports (book_id, user_email, fingerprint, stats_json, created_at)
                                                VALUES (?, ?, ?, ?, ?)`).run(bookId, userEmail, fingerprint, JSON.stringify(stats), createdAt);
    const ins = db.prepare('INSERT INTO finetune_export_files (export_id, kind, data_gz, bytes) VALUES (?, ?, ?, ?)');
    for (const [kind, data, bytes] of packed) ins.run(id, kind, data, bytes);
    db.prepare(`DELETE FROM finetune_exports WHERE book_id = ? AND user_email = ? AND id NOT IN (
                  SELECT id FROM finetune_exports WHERE book_id = ? AND user_email = ?
                  ORDER BY created_at DESC, id DESC LIMIT ?)`).run(bookId, userEmail, bookId, userEmail, KEEP_EXPORTS);
    return Number(id);
  })();
}

module.exports = {
  KEEP_EXPORTS, FINETUNE_FILE_KINDS, bookFingerprint,
  listFinetuneExports, getFinetuneExport, readFinetuneFile, deleteFinetuneExport, saveFinetuneExport,
};

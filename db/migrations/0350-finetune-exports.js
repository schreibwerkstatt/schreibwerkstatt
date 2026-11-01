'use strict';
// Fine-Tuning-Exporte (docs/finetuning.md): die erzeugten Trainingssets eines
// Users fürs Buch, als Verlauf. Eine Zeile je Set (Fingerabdruck des
// Buchstands + Statistik), die Dateien (train/val/all/eval/val-*) gzip-
// komprimiert als BLOB je Art. Vorher lagen sie als Dateien neben der DB
// (`finetune-exports/`) — ausserhalb des Backups und ohne Aufräumen beim
// Löschen von Buch oder Konto.
//
// book_id + user_email CASCADE: abgeleitete Daten, ohne Buch bzw. Konto
// gegenstandslos. Die Dateien hängen per CASCADE am Set.
//
// Import des Altbestands: ein flaches Set (`<book>-<sha1(email)[0:16]>.*.jsonl`
// + `.meta.json`) oder ein Set im Unterordner (`<book>-<hash>/<id>/…`) wird
// übernommen, wenn Buch und Konto noch existieren. Die Dateien bleiben liegen —
// gelöscht wird von Hand, nicht in einer Migration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const KINDS = ['train', 'val', 'all', 'eval', 'val-facts', 'val-writing', 'val-refusal'];

function legacySets(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const sets = [];
  for (const name of names) {
    const flat = name.match(/^(\d+)-([0-9a-f]{16})\.meta\.json$/);
    if (flat) {
      const base = path.join(dir, name.slice(0, -'.meta.json'.length));
      sets.push({ bookId: Number(flat[1]), hash: flat[2], meta: `${base}.meta.json`, file: (k) => `${base}.${k}.jsonl` });
      continue;
    }
    const folder = name.match(/^(\d+)-([0-9a-f]{16})$/);
    if (!folder) continue;
    let subs;
    try { subs = fs.readdirSync(path.join(dir, name)); } catch { continue; }
    for (const sub of subs) {
      const d = path.join(dir, name, sub);
      if (fs.existsSync(path.join(d, 'meta.json'))) {
        sets.push({ bookId: Number(folder[1]), hash: folder[2], meta: path.join(d, 'meta.json'), file: (k) => path.join(d, `${k}.jsonl`) });
      }
    }
  }
  return sets;
}

module.exports = {
  version: 350,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS finetune_exports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        fingerprint TEXT    NOT NULL,
        stats_json  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_finetune_exports_book_user ON finetune_exports(book_id, user_email, created_at);
      CREATE INDEX IF NOT EXISTS idx_finetune_exports_user_email ON finetune_exports(user_email);

      CREATE TABLE IF NOT EXISTS finetune_export_files (
        export_id INTEGER NOT NULL REFERENCES finetune_exports(id) ON DELETE CASCADE,
        kind      TEXT    NOT NULL CHECK (kind IN ('train','val','all','eval','val-facts','val-writing','val-refusal')),
        data_gz   BLOB    NOT NULL,
        bytes     INTEGER NOT NULL,
        PRIMARY KEY (export_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_finetune_export_files_export_id ON finetune_export_files(export_id);
    `);

    if (!db.name || db.memory) return;
    const dir = path.resolve(process.env.FINETUNE_DIR || path.join(path.dirname(db.name), 'finetune-exports'));
    const sets = legacySets(dir);
    if (!sets.length) return;
    const emailByHash = new Map(db.prepare('SELECT email FROM app_users').all()
      .map(r => [crypto.createHash('sha1').update(String(r.email)).digest('hex').slice(0, 16), r.email]));
    const bookExists = db.prepare('SELECT 1 FROM books WHERE book_id = ?');
    const insExport = db.prepare(`INSERT INTO finetune_exports (book_id, user_email, fingerprint, stats_json, created_at)
                                  VALUES (?, ?, ?, ?, ?)`);
    const insFile = db.prepare('INSERT INTO finetune_export_files (export_id, kind, data_gz, bytes) VALUES (?, ?, ?, ?)');
    for (const s of sets) {
      const email = emailByHash.get(s.hash);
      if (!email || !bookExists.get(s.bookId)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(s.meta, 'utf8')); } catch { continue; }
      const createdAt = meta.createdAt || fs.statSync(s.meta).mtime.toISOString();
      const { lastInsertRowid: id } = insExport.run(s.bookId, email, meta.fingerprint || '', JSON.stringify(meta.stats || {}), createdAt);
      for (const kind of KINDS) {
        let buf;
        try { buf = fs.readFileSync(s.file(kind)); } catch { continue; }
        if (!buf.length) continue;
        insFile.run(id, kind, zlib.gzipSync(buf), buf.length);
      }
    }
  },
};

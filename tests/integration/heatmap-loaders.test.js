'use strict';
// Lesepfade der beiden Heatmaps gegen echte SQLite: db/style-stats.js und
// db/lektorat-heatmap.js. Geprueft wird, was nur die SQL-Schicht entscheidet —
// die Reihenfolge der Zeilen und die Spalten, die die pure Aggregation braucht.

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let styleStats;
let lektoratHeatmap;

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/connection').db;
  styleStats = require('../../db/style-stats');
  lektoratHeatmap = require('../../db/lektorat-heatmap');
});
test.after(() => { ctx.cleanup(); });

const NOW = '2026-05-01T10:00:00.000Z';
const USER = 'heatmap@test.local';

function seedBook(name) {
  return db.prepare(`INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES (?, '', ?, ?, NULL)`).run(name, NOW, NOW).lastInsertRowid;
}
function seedChapter(bookId, name, position) {
  return db.prepare(`INSERT INTO chapters (book_id, chapter_name, position, updated_at)
    VALUES (?, ?, ?, ?)`).run(bookId, name, position, NOW).lastInsertRowid;
}
function seedPage(bookId, chapterId, name, position) {
  return db.prepare(`INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, updated_at, local_updated_at)
    VALUES (?, ?, ?, '<p/>', ?, ?, ?)`).run(bookId, chapterId, name, position, NOW, NOW).lastInsertRowid;
}
function seedStats(bookId, pageId, sentenceLens) {
  db.prepare(`INSERT INTO page_stats (page_id, book_id, words, chars, sentence_lens, metrics_version, cached_at)
    VALUES (?, ?, 100, 600, ?, 9, ?)`).run(pageId, bookId, JSON.stringify(sentenceLens), NOW);
}

test('loadStyleRows: Lesereihenfolge nach position, nicht nach Anlage-ID', () => {
  // Kapitel B wird zuerst angelegt, steht im Buch aber hinter A; in A wurde
  // die zweite Seite vor die erste geschoben. Die Satzlaengen-Sequenz (Rhythmus)
  // haengt an genau dieser Reihenfolge.
  const bookId = seedBook('stil-order');
  const chB = seedChapter(bookId, 'B', 1);
  const chA = seedChapter(bookId, 'A', 0);
  const a2 = seedPage(bookId, chA, 'A-zwei', 1);
  const a1 = seedPage(bookId, chA, 'A-eins', 0);
  const b1 = seedPage(bookId, chB, 'B-eins', 0);
  const loose = seedPage(bookId, null, 'lose', 0);
  for (const [pid, lens] of [[a2, [2]], [a1, [1]], [b1, [3]], [loose, [4]]]) seedStats(bookId, pid, lens);

  const rows = styleStats.loadStyleRows(bookId);
  assert.deepEqual(rows.map(r => r.page_id), [a1, a2, b1, loose]);

  // Drilldown eines Kapitels ebenfalls in Seitenreihenfolge.
  const samples = styleStats.loadStyleSamples(bookId, chA);
  assert.deepEqual(samples.map(r => r.page_id), [a1, a2]);
});

test('loadHeatmapRows: liefert id/checked_at/saved_at fuer den Annahme-Abgleich', () => {
  db.prepare(`INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)`).run(USER, NOW);
  const bookId = seedBook('fehler-rows');
  const ch = seedChapter(bookId, 'K', 0);
  const pid = seedPage(bookId, ch, 'S', 0);
  const ins = db.prepare(`INSERT INTO page_checks
    (page_id, book_id, checked_at, errors_json, applied_errors_json, saved_at, user_email)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const f = JSON.stringify([{ typ: 'stil', original: 'x' }]);
  const older = ins.run(pid, bookId, '2026-05-01T08:00:00.000Z', f, f, '2026-05-01T09:30:00.000Z', USER).lastInsertRowid;
  const latest = ins.run(pid, bookId, '2026-05-01T09:00:00.000Z', f, null, null, USER).lastInsertRowid;

  const { checks, appliedRows } = lektoratHeatmap.loadHeatmapRows(bookId, USER);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, latest);
  assert.equal(checks[0].checked_at, '2026-05-01T09:00:00.000Z');
  assert.equal(appliedRows.length, 1);
  assert.equal(appliedRows[0].id, older);
  assert.equal(appliedRows[0].saved_at, '2026-05-01T09:30:00.000Z');
});

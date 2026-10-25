'use strict';
// Integration: Buch-Chat-Werkzeug list_redundancies (routes/jobs/chat-tools/
// tools-redundancy.js). Liest den gespeicherten Radar-Lauf und filtert zur
// Lesezeit wie die Karte: Paare mit einer Seite, die nicht mehr im Buch steht,
// mit einer seither neu angelegten Figur oder nach dem Lauf ignoriert, fallen weg.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

const ME = 'red-chat@test.dev';
const OTHER = 'red-chat-other@test.dev';
const BOOK = 9501;
const OTHER_BOOK = 9502;
const NOW = '2026-01-01T00:00:00.000Z';
const RUN_AT = '2026-02-01T00:00:00.000Z';
const P = { p1: 950101, p2: 950102, p3: 950103, p4: 950104, moved: 950201 };

let ctx; let db; let tools; let redundancyDb;
const F = {};

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  tools = require('../../routes/jobs/chat-tools');
  redundancyDb = require('../../db/redundancy');

  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)');
  insBook.run(BOOK, 'Buch', NOW, NOW, ME);
  insBook.run(OTHER_BOOK, 'Anderes', NOW, NOW, ME);
  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)');
  insChap.run(95011, BOOK, 'Anfang', 0, NOW);
  insChap.run(95012, BOOK, 'Ende', 1, NOW);
  insChap.run(95021, OTHER_BOOK, 'Fremd', 0, NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, ?, ?, '<p>x</p>')`);
  insPage.run(P.p1, BOOK, 'Ankunft', 95011, 0, NOW);
  insPage.run(P.p2, BOOK, 'Abschied', 95011, 1, NOW);
  insPage.run(P.p3, BOOK, 'Rückkehr', 95012, 0, '2026-03-01T00:00:00.000Z'); // nach dem Lauf bearbeitet
  insPage.run(P.p4, BOOK, 'Nachspiel', 95012, 1, NOW);
  insPage.run(P.moved, OTHER_BOOK, 'Verschoben', 95021, 0, NOW);

  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, sort_order, updated_at)
                             VALUES (?, ?, ?, ?, ?, 0, ?)`);
  F.anna = insFig.run(BOOK, ME, 'fig_anna', 'Anna Berg', 'Anna', NOW).lastInsertRowid;
  F.frau = insFig.run(BOOK, ME, 'fig_frau', 'Die Frau am Fenster', null, NOW).lastInsertRowid;
  F.ben = insFig.run(BOOK, ME, 'fig_ben', 'Ben', null, NOW).lastInsertRowid;

  const pair = (a, b, score) => ({ a_id: a, a_ix: 0, a_text: `Text ${a} `.repeat(80), b_id: b, b_ix: 1, b_text: `Text ${b}`, score });
  redundancyDb.saveRun(BOOK, ME, 0.82, {
    model: 'test-embed', threshold: 0.82, skipAdjacent: true, totalFound: 4, truncated: false, truncatedChunks: 0,
    pairs: [
      pair(P.p1, P.p3, 0.93),
      pair(P.p2, P.moved, 0.91),     // Seite liegt nicht mehr im Buch
      pair(P.p1, P.p4, 0.88),        // nach dem Lauf ignoriert
      pair(P.p2, P.p4, 0.85),
    ],
    figures: {
      pairs: [
        { a_id: F.anna, b_id: F.frau, score: 0.9, dupeKind: 'alias', a_name: 'Anna Berg', b_name: 'Die Frau am Fenster' },
        { a_id: F.anna, b_id: 999999, score: 0.89, dupeKind: 'duplicate', a_name: 'Anna Berg', b_name: 'Weg' },
      ],
      totalFound: 2,
    },
    createdAt: RUN_AT,
  });
  // saveRun stempelt «jetzt»; der Lauf soll vor der Bearbeitung von P3 liegen.
  db.prepare('UPDATE redundancy_runs SET created_at = ? WHERE book_id = ?').run(RUN_AT, BOOK);
  assert.ok(redundancyDb.addDismissal(BOOK, ME, 'page', P.p4, P.p1));
});
test.after(() => { ctx.cleanup(); });

const call = (input, user = ME) => tools.TOOLS.list_redundancies(input, { bookId: BOOK, userEmail: user });

test('ohne Lauf: leere Listen + Hinweis, dass das nichts beweist', async () => {
  const r = await call({}, OTHER);
  assert.deepEqual(r.page_pairs, []);
  assert.deepEqual(r.figure_pairs, []);
  assert.match(r.hint, /Kein Lauf/);
});

test('Passagen-Paare: Namen + Kapitel zur Lesezeit, verschobene und ignorierte fallen weg', async () => {
  const r = await call({});
  assert.equal(r.total_page_pairs, 2);
  assert.deepEqual(r.page_pairs.map(p => [p.a.page_id, p.b.page_id]), [[P.p1, P.p3], [P.p2, P.p4]]);
  const first = r.page_pairs[0];
  assert.equal(first.score, 0.93);
  assert.equal(first.a.page_name, 'Ankunft');
  assert.equal(first.b.chapter_path, 'Ende');
  assert.equal(first.b.changed_since_run, true);
  assert.equal(first.a.changed_since_run, undefined);
  assert.ok(first.a.text.length <= 301, 'Passagentext auf text_chars gekürzt');
  assert.match(r.hint, /changed_since_run/);
});

test('Figuren-Paare: nur bestehende Figuren, aktuelle Namen, art', async () => {
  const r = await call({ kind: 'figure' });
  assert.deepEqual(r.page_pairs, []);
  assert.equal(r.figure_pairs.length, 1);
  assert.deepEqual(r.figure_pairs[0], {
    score: 0.9, art: 'alias', a: { fig_id: 'fig_anna', name: 'Anna Berg' }, b: { fig_id: 'fig_frau', name: 'Die Frau am Fenster' },
  });
});

test('chapter_id: Paare mit mindestens einem Abschnitt im Kapitel, Figuren entfallen', async () => {
  const r = await call({ chapter_id: 95012 });
  assert.deepEqual(r.page_pairs.map(p => [p.a.page_id, p.b.page_id]), [[P.p1, P.p3], [P.p2, P.p4]]);
  assert.deepEqual(r.figure_pairs, []);
  const r2 = await call({ chapter_id: 95011, limit: 1 });
  assert.equal(r2.page_pairs.length, 1);
  assert.equal(r2.total_page_pairs, 2);
  assert.match(r2.hint, /Gekürzt auf 1 von 2/);
});

'use strict';
// Integration: der Buch-Chat kennt Gliederung und Lesereihenfolge. Quelle ist
// book_order.order_json (contentStore.bookOutline) — inklusive verschachtelter
// Kapitel und eigener Abschnitte eines Kapitels, die NACH seinen Unterkapiteln
// stehen (aus pages.position nicht rekonstruierbar).

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let TOOLS;
let db;
let contentStore;

const BOOK = 9201;
const U = 'alice@example.com';
const call = (name, input = {}) => TOOLS[name](input, { bookId: BOOK, userEmail: U, inputBudgetChars: 100000 });

// Lesereihenfolge:
//   · Prolog
//   ▸ Teil Eins
//     · Intro
//     ▸ Kapitel 1.1
//       · B1
//       ▸ Szene 1.1.1
//         · C1
//     · Zwischenspiel      ← eigener Abschnitt von «Teil Eins» nach dessen Unterkapitel
//     ▸ Kapitel 1.2
//       · B2
//   ▸ Teil Zwei            ← keine eigenen Abschnitte
//     ▸ Kapitel 2.1
//       · D1
//   · Epilog
const TREE = [
  { type: 'page', id: 920100 },
  { type: 'chapter', id: 92011, children: [
    { type: 'page', id: 920111 },
    { type: 'chapter', id: 920111, children: [
      { type: 'page', id: 920112 },
      { type: 'chapter', id: 9201111, children: [{ type: 'page', id: 920113 }] },
    ] },
    { type: 'page', id: 920114 },
    { type: 'chapter', id: 920112, children: [{ type: 'page', id: 920115 }] },
  ] },
  { type: 'chapter', id: 92012, children: [
    { type: 'chapter', id: 920121, children: [{ type: 'page', id: 920121 }] },
  ] },
  { type: 'page', id: 920199 },
];

function seed() {
  // Positionen absichtlich gegen die Lesereihenfolge — die Gliederung muss aus
  // dem Tree kommen, nicht aus position.
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Gliederung' }],
    chapters: [
      { id: 92011,   book_id: BOOK, name: 'Teil Eins',   position: 5 },
      { id: 920111,  book_id: BOOK, name: 'Kapitel 1.1', position: 4 },
      { id: 9201111, book_id: BOOK, name: 'Szene 1.1.1', position: 3 },
      { id: 920112,  book_id: BOOK, name: 'Kapitel 1.2', position: 2 },
      { id: 92012,   book_id: BOOK, name: 'Teil Zwei',   position: 1 },
      { id: 920121,  book_id: BOOK, name: 'Kapitel 2.1', position: 0 },
    ],
    pages: [
      { id: 920100, book_id: BOOK, name: 'Prolog',        position: 9 },
      { id: 920111, book_id: BOOK, name: 'Intro',         chapter_id: 92011,   position: 1 },
      { id: 920112, book_id: BOOK, name: 'B1',            chapter_id: 920111,  position: 0 },
      { id: 920113, book_id: BOOK, name: 'C1',            chapter_id: 9201111, position: 0 },
      { id: 920114, book_id: BOOK, name: 'Zwischenspiel', chapter_id: 92011,   position: 0 },
      { id: 920115, book_id: BOOK, name: 'B2',            chapter_id: 920112,  position: 0 },
      { id: 920121, book_id: BOOK, name: 'D1',            chapter_id: 920121,  position: 0 },
      { id: 920199, book_id: BOOK, name: 'Epilog',        position: 0 },
    ],
    pageBodies: {
      920100: '<p>Prolog. Mara wartet.</p>',
      920111: '<p>Intro-Text.</p>',
      920112: '<p>B1-Text.</p>',
      920113: '<p>C1-Text.</p>',
      920114: '<p>Zwischenspiel. Mara geht.</p>',
      920115: '<p>B2-Text.</p>',
      920121: '<p>D1-Text.</p>',
      920199: '<p>Epilog. Mara kehrt zurück.</p>',
    },
  });
  require('../../db/book-order').putOrder(BOOK, TREE);

  const insPs = db.prepare('INSERT INTO page_stats (page_id, book_id, words, chars) VALUES (?, ?, ?, ?)');
  for (const [id, w] of [[920111, 10], [920112, 20], [920113, 30], [920114, 5], [920115, 7], [920121, 11]]) {
    insPs.run(id, BOOK, w, w * 6);
  }

  const fig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, sort_order, updated_at)
                          VALUES (?, ?, 'fig_mara', 'Mara', 'Mara', 0, '2026-01-01T00:00:00.000Z')`).run(BOOK, U).lastInsertRowid;
  const insPfm = db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, 1, 0)');
  // Epilog hat position 0 und kein Kapitel — nach SQL-Sortierung stünde er vorn.
  for (const id of [920199, 920114, 920100]) insPfm.run(id, fig);
}

test.before(() => {
  ctx = bootstrap();
  TOOLS = require('../../routes/jobs/book-chat-tools').TOOLS;
  db = require('../../db/connection').db;
  contentStore = require('../../lib/content-store');
  seed();
});
test.after(() => { ctx.cleanup(); });

test('bookOutline: Kapitel und Abschnitte verschränkt in Lesereihenfolge, mit Tiefe und Pfad', async () => {
  const o = await contentStore.bookOutline(BOOK);
  assert.deepEqual(o.map(n => `${n.type === 'chapter' ? '▸' : '·'}${n.depth}:${n.name}`), [
    '·0:Prolog', '▸1:Teil Eins', '·1:Intro', '▸2:Kapitel 1.1', '·2:B1', '▸3:Szene 1.1.1', '·3:C1',
    '·1:Zwischenspiel', '▸2:Kapitel 1.2', '·2:B2', '▸1:Teil Zwei', '▸2:Kapitel 2.1', '·2:D1', '·0:Epilog',
  ]);
  const c1 = o.find(n => n.type === 'page' && n.id === 920113);
  assert.equal(contentStore.formatChapterPath(c1.path), 'Teil Eins › Kapitel 1.1 › Szene 1.1.1');
  assert.deepEqual(c1.chapter_ids, [92011, 920111, 9201111]);
});

test('list_chapters: Hierarchie (depth/parent), Fortsetzung nach Unterkapiteln, Wortsummen', async () => {
  const r = await call('list_chapters');
  assert.deepEqual(r.chapters.map(c => [c.chapter_name ?? null, c.depth, c.parent_chapter_id ?? null, !!c.continued, c.pages.map(p => p[1])]), [
    [null,          0, null,   false, ['Prolog']],
    ['Teil Eins',   1, null,   false, ['Intro']],
    ['Kapitel 1.1', 2, 92011,  false, ['B1']],
    ['Szene 1.1.1', 3, 920111, false, ['C1']],
    ['Teil Eins',   1, null,   true,  ['Zwischenspiel']],
    ['Kapitel 1.2', 2, 92011,  false, ['B2']],
    ['Teil Zwei',   1, null,   false, []],
    ['Kapitel 2.1', 2, 92012,  false, ['D1']],
    [null,          0, null,   false, ['Epilog']],
  ]);
  assert.equal(r.total_chapters, 6);
  assert.equal(r.total_entries, 9);
  const teilEins = r.chapters[1];
  assert.equal(teilEins.words, 15);          // Intro + Zwischenspiel
  assert.equal(teilEins.words_total, 72);    // inkl. aller Unterkapitel
  assert.equal(r.chapters[3].words_total, undefined); // Blatt-Kapitel: keine Doppelangabe
});

test('get_chapter_text: Unterkapitel standardmässig in Lesereihenfolge dabei', async () => {
  const r = await call('get_chapter_text', { chapter_id: 92011 });
  assert.deepEqual(r.pages.map(p => p.page_name), ['Intro', 'B1', 'C1', 'Zwischenspiel', 'B2']);
  assert.equal(r.total_pages, 5);
  assert.deepEqual(r.subchapters.map(c => [c.chapter_name, c.depth]), [['Kapitel 1.1', 2], ['Szene 1.1.1', 3], ['Kapitel 1.2', 2]]);
  // Abschnitt eines Unterkapitels nennt sein direktes Kapitel, eigene nicht.
  assert.equal(r.pages[2].chapter_name, 'Szene 1.1.1');
  assert.equal(r.pages[0].chapter_name, undefined);
});

test('get_chapter_text: Oberkapitel ohne eigene Abschnitte liefert den Text der Unterkapitel', async () => {
  const r = await call('get_chapter_text', { chapter_id: 92012 });
  assert.deepEqual(r.pages.map(p => [p.page_name, p.chapter_name]), [['D1', 'Kapitel 2.1']]);
  assert.match(r.pages[0].text, /D1-Text/);
  const only = await call('get_chapter_text', { chapter_id: 92012, include_subchapters: false });
  assert.equal(only.total_pages, 0);
  assert.deepEqual(only.subchapters.map(c => c.chapter_id), [920121]);
});

test('get_chapter_text: Unter-Unterkapitel mit Pfad', async () => {
  const r = await call('get_chapter_text', { chapter_id: 9201111 });
  assert.equal(r.depth, 3);
  assert.equal(r.chapter_path, 'Teil Eins › Kapitel 1.1 › Szene 1.1.1');
  assert.deepEqual(r.pages.map(p => p.page_name), ['C1']);
});

test('get_pages: chapter_path nur bei Unterkapiteln', async () => {
  const r = await call('get_pages', { ids: [920113, 920111, 920100] });
  const byName = Object.fromEntries(r.pages.map(p => [p.page_name, p.chapter_path]));
  assert.equal(byName.C1, 'Teil Eins › Kapitel 1.1 › Szene 1.1.1');
  assert.equal(byName.Intro, undefined);
  assert.equal(byName.Prolog, undefined);
});

test('Figuren-Erwähnungen: erste/letzte Stelle nach Gliederung, nicht nach position', async () => {
  const m = await call('get_figure_mentions', { figur_id: 'fig_mara' });
  assert.equal(m.first_appearance.page_name, 'Prolog');
  assert.equal(m.last_appearance.page_name, 'Epilog');
  const f = await call('find_first_last_mention', { figur_id: 'fig_mara' });
  assert.equal(f.first_appearance.page_name, 'Prolog');
  assert.equal(f.last_appearance.page_name, 'Epilog');
});

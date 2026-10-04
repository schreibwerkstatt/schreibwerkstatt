'use strict';
// book_order — Validator, Materializer, Overlay,
// Reconcile. Integration-Test (echte SQLite, lokales Schema).

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookOrder;
let contentStore;
let db;

test.before(() => {
  ctx = bootstrap();
  bookOrder = require('../../db/book-order');
  contentStore = require('../../lib/content-store');
  db = require('../../db/connection').db;
  require('../../lib/app-settings').set('app.backend', 'localdb', { updatedBy: 'test' });
});
test.after(() => { ctx.cleanup(); });

function seedBook(name = 'BO-Test') {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email)
    VALUES (?, '', ?, ?, NULL)
  `).run(name, now, now).lastInsertRowid;
}
function seedChapter(bookId, name, position = 0) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(bookId, name, position, now).lastInsertRowid;
}
function seedPage(bookId, chapterId, name, position = 0) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, updated_at, local_updated_at)
    VALUES (?, ?, ?, '<p/>', ?, ?, ?)
  `).run(bookId, chapterId, name, position, now, now).lastInsertRowid;
}

test('validateTree akzeptiert vollstaendigen, sauberen Baum', () => {
  const bookId = seedBook('valid-tree');
  const c1 = seedChapter(bookId, 'C1');
  const c2 = seedChapter(bookId, 'C2');
  const p1 = seedPage(bookId, c1, 'P1');
  const p2 = seedPage(bookId, c1, 'P2');
  const p3 = seedPage(bookId, null, 'Top');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p2 }] },
    { type: 'page', id: p3 },
    { type: 'chapter', id: c2, children: [] },
  ];
  assert.doesNotThrow(() => bookOrder.validateTree(tree, bookId));
});

test('validateTree wirft auf doppelte Page', () => {
  const bookId = seedBook('dup');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p1 }] },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'DUPLICATE_PAGE');
});

test('validateTree wirft auf fehlende Page (Vollstaendigkeit)', () => {
  const bookId = seedBook('miss');
  const c1 = seedChapter(bookId, 'C1');
  seedPage(bookId, c1, 'P1'); // fehlt im Tree
  const tree = [{ type: 'chapter', id: c1, children: [] }];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'MISSING_PAGE');
});

test('validateTree wirft auf unbekannte ID', () => {
  const bookId = seedBook('unknown');
  const tree = [{ type: 'chapter', id: 999_999_999, children: [] }];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'UNKNOWN_CHAPTER');
});

test('validateTree akzeptiert verschachteltes Kapitel bis MAX_CHAPTER_DEPTH', () => {
  const bookId = seedBook('nest');
  const c1 = seedChapter(bookId, 'C1');
  const c2 = seedChapter(bookId, 'C2');
  const c3 = seedChapter(bookId, 'C3');
  const tree = [
    {
      type: 'chapter', id: c1, children: [
        { type: 'chapter', id: c2, children: [
          { type: 'chapter', id: c3, children: [] },
        ]},
      ],
    },
  ];
  assert.doesNotThrow(() => bookOrder.validateTree(tree, bookId));
});

test('validateTree wirft bei Ueberschreiten von MAX_CHAPTER_DEPTH', () => {
  const bookId = seedBook('deep');
  const c1 = seedChapter(bookId, 'C1');
  const c2 = seedChapter(bookId, 'C2');
  const c3 = seedChapter(bookId, 'C3');
  const c4 = seedChapter(bookId, 'C4');
  const tree = [
    {
      type: 'chapter', id: c1, children: [
        { type: 'chapter', id: c2, children: [
          { type: 'chapter', id: c3, children: [
            { type: 'chapter', id: c4, children: [] },
          ]},
        ]},
      ],
    },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.ok(err, 'erwarteter Fehler');
  assert.equal(err.code, 'MAX_DEPTH');
});

test('materializeTree setzt chapters.position, pages.position, pages.chapter_id', () => {
  const bookId = seedBook('materialize');
  const cA = seedChapter(bookId, 'A', 99);
  const cB = seedChapter(bookId, 'B', 99);
  const pA1 = seedPage(bookId, cA, 'A1', 99);
  const pA2 = seedPage(bookId, cA, 'A2', 99);
  const pTop = seedPage(bookId, null, 'Top', 99);
  const tree = [
    { type: 'chapter', id: cB, children: [] },
    { type: 'chapter', id: cA, children: [{ type: 'page', id: pA2 }, { type: 'page', id: pA1 }] },
    { type: 'page', id: pTop },
  ];
  bookOrder.putOrder(bookId, tree, 'test@example.com');

  const cAPos = db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cA).position;
  const cBPos = db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cB).position;
  assert.equal(cBPos, 0);
  assert.equal(cAPos, 1);
  const pA2Pos = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pA2);
  const pA1Pos = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pA1);
  assert.equal(pA2Pos.position, 0);
  assert.equal(pA1Pos.position, 1);
  assert.equal(pA2Pos.chapter_id, cA);
  const topRow = db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(pTop);
  assert.equal(topRow.position, 0);
  assert.equal(topRow.chapter_id, null);
});

test('putOrder persistiert order_json + updated_by', () => {
  const bookId = seedBook('persist');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ], 'alice@example.com');
  const r = bookOrder.getOrder(bookId);
  assert.deepEqual(r.tree, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ]);
  assert.equal(r.updated_by, 'alice@example.com');
  assert.ok(r.updated_at);
});

test('ensureTree initialisiert aus position, wenn keine Row existiert', () => {
  const bookId = seedBook('init');
  const c1 = seedChapter(bookId, 'C1', 0);
  const c2 = seedChapter(bookId, 'C2', 1);
  const p1 = seedPage(bookId, c1, 'P1', 0);
  const p2 = seedPage(bookId, c2, 'P2', 0);
  const pTop = seedPage(bookId, null, 'Top', 0);

  const r = bookOrder.ensureTree(bookId);
  assert.ok(r.tree);
  // C1 (pos 0), Top (pos 0, chapter-first heuristic), C2 (pos 1)
  // Aktuelles Heuristik-Verhalten: Chapter-first bei Gleichstand.
  const ids = r.tree.map(e => `${e.type}:${e.id}`);
  assert.ok(ids.includes(`chapter:${c1}`));
  assert.ok(ids.includes(`chapter:${c2}`));
  assert.ok(ids.includes(`page:${pTop}`));
  // P1 unter C1, P2 unter C2.
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.deepEqual(c1Entry.children, [{ type: 'page', id: p1 }]);
  const c2Entry = r.tree.find(e => e.type === 'chapter' && e.id === c2);
  assert.deepEqual(c2Entry.children, [{ type: 'page', id: p2 }]);
});

test('ensureTree reconciliert neue + geloeschte Items', () => {
  const bookId = seedBook('reconcile');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] },
  ], 'test');

  // Hinzu: neues Kapitel + neue Seite ohne PUT.
  const c2 = seedChapter(bookId, 'C2');
  const p2 = seedPage(bookId, c2, 'P2');
  const pNew = seedPage(bookId, null, 'TopNew');

  // Geloescht: P1 via DELETE (Cascade aus chapters bei FK ON DELETE SET NULL
  // greift nicht — pages.chapter_id ist ON DELETE SET NULL. Direkter Delete.)
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(p1);

  const r = bookOrder.ensureTree(bookId);
  const idsTop = r.tree.map(e => `${e.type}:${e.id}`);
  assert.ok(idsTop.includes(`chapter:${c1}`), 'C1 bleibt');
  assert.ok(idsTop.includes(`chapter:${c2}`), 'C2 angehaengt');
  assert.ok(idsTop.includes(`page:${pNew}`), 'TopNew angehaengt');
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.equal(c1Entry.children.length, 0, 'P1 entfernt');
  const c2Entry = r.tree.find(e => e.type === 'chapter' && e.id === c2);
  assert.deepEqual(c2Entry.children, [{ type: 'page', id: p2 }]);
});

test('ensureTree sortiert neue Seite mit chapter_id unter bestehendes Kapitel', () => {
  const bookId = seedBook('reconcile-page-into-chapter');
  const c1 = seedChapter(bookId, 'C1');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [] },
  ], 'test');

  // Neue Seite per Direct-Insert mit chapter_id (simuliert createPage-Pfad,
  // der book_order nicht selbst pflegt).
  const pNew = seedPage(bookId, c1, 'Neue Seite');

  const r = bookOrder.ensureTree(bookId);
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.deepEqual(c1Entry.children, [{ type: 'page', id: pNew }],
    'neue Seite landet unter ihrem Kapitel, nicht als Top-Level-Waise');
  const topPage = r.tree.find(e => e.type === 'page' && e.id === pNew);
  assert.equal(topPage, undefined, 'Seite erscheint nicht zusätzlich top-level');
});

test('validateTree wirft auf NOT_ARRAY', () => {
  const bookId = seedBook('not-array');
  let err;
  try { bookOrder.validateTree({ not: 'array' }, bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'NOT_ARRAY');
});

test('validateTree wirft auf BAD_TYPE', () => {
  const bookId = seedBook('bad-type');
  let err;
  try { bookOrder.validateTree([{ type: 'section', id: 1 }], bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'BAD_TYPE');
});

test('validateTree wirft auf BAD_ID (negative/float/null)', () => {
  const bookId = seedBook('bad-id');
  for (const badId of [0, -1, 1.5, null, '1', undefined]) {
    let err;
    try { bookOrder.validateTree([{ type: 'chapter', id: badId, children: [] }], bookId); } catch (e) { err = e; }
    assert.equal(err?.code, 'BAD_ID', `id=${String(badId)}`);
  }
});

test('validateTree wirft auf DUPLICATE_CHAPTER', () => {
  const bookId = seedBook('dup-chapter');
  const c1 = seedChapter(bookId, 'C1');
  const tree = [
    { type: 'chapter', id: c1, children: [] },
    { type: 'chapter', id: c1, children: [] },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'DUPLICATE_CHAPTER');
});

test('validateTree wirft auf CHILDREN_NOT_ARRAY', () => {
  const bookId = seedBook('children-not-array');
  const c1 = seedChapter(bookId, 'C1');
  let err;
  try { bookOrder.validateTree([{ type: 'chapter', id: c1, children: 'oops' }], bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'CHILDREN_NOT_ARRAY');
});

test('validateTree wirft auf PAGE_HAS_CHILDREN', () => {
  const bookId = seedBook('page-has-children');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  const tree = [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1, children: [{ type: 'page', id: 99 }] }] },
  ];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'PAGE_HAS_CHILDREN');
});

test('validateTree wirft auf MISSING_CHAPTER', () => {
  const bookId = seedBook('miss-chapter');
  const c1 = seedChapter(bookId, 'C1');
  seedChapter(bookId, 'C2');
  const tree = [{ type: 'chapter', id: c1, children: [] }];
  let err;
  try { bookOrder.validateTree(tree, bookId); } catch (e) { err = e; }
  assert.equal(err?.code, 'MISSING_CHAPTER');
});

test('materializeTree haelt Positionen pro Bucket lueckenlos + 0-basiert', () => {
  const bookId = seedBook('positions-bucketed');
  const cA = seedChapter(bookId, 'A');
  const cB = seedChapter(bookId, 'B');
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(seedPage(bookId, cA, `A${i}`, 99));
  for (let i = 0; i < 3; i++) ids.push(seedPage(bookId, cB, `B${i}`, 99));
  for (let i = 0; i < 2; i++) ids.push(seedPage(bookId, null, `T${i}`, 99));

  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cA, children: ids.slice(0, 4).map(id => ({ type: 'page', id })) },
    { type: 'page', id: ids[7] },
    { type: 'chapter', id: cB, children: ids.slice(4, 7).map(id => ({ type: 'page', id })) },
    { type: 'page', id: ids[8] },
  ], 'test');

  // Chapter-Positionen: 0,1 (Top-Pages dazwischen werden separat indiziert).
  assert.equal(db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cA).position, 0);
  assert.equal(db.prepare('SELECT position FROM chapters WHERE chapter_id = ?').get(cB).position, 1);

  // Pages pro Kapitel: 0..n-1
  const posOf = (id) => db.prepare('SELECT position, chapter_id FROM pages WHERE page_id = ?').get(id);
  ids.slice(0, 4).forEach((id, i) => { const r = posOf(id); assert.equal(r.position, i); assert.equal(r.chapter_id, cA); });
  ids.slice(4, 7).forEach((id, i) => { const r = posOf(id); assert.equal(r.position, i); assert.equal(r.chapter_id, cB); });
  // Top-Pages: 0..n-1, chapter_id=null
  assert.equal(posOf(ids[7]).position, 0); assert.equal(posOf(ids[7]).chapter_id, null);
  assert.equal(posOf(ids[8]).position, 1); assert.equal(posOf(ids[8]).chapter_id, null);
});

test('putOrder ist idempotent (zweimal → identischer Stand)', () => {
  const bookId = seedBook('idempotent');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  const tree = [{ type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }] }];
  bookOrder.putOrder(bookId, tree, 'alice');
  const r1 = bookOrder.getOrder(bookId);
  bookOrder.putOrder(bookId, tree, 'bob');
  const r2 = bookOrder.getOrder(bookId);
  assert.deepEqual(r2.tree, r1.tree);
  assert.equal(r2.updated_by, 'bob');
});

test('ensureTree ohne books-Row liefert leeren Tree (defensiv, kein FK-Throw)', () => {
  const r = bookOrder.ensureTree(999_999_999);
  assert.deepEqual(r.tree, []);
  assert.equal(r.updated_at, null);
});

test('ensureTree ist idempotent (zweiter Aufruf ändert order_json nicht)', () => {
  const bookId = seedBook('ensure-idempotent');
  seedChapter(bookId, 'C1');
  seedPage(bookId, null, 'Top');
  const r1 = bookOrder.ensureTree(bookId);
  const r2 = bookOrder.ensureTree(bookId);
  assert.deepEqual(r2.tree, r1.tree);
  assert.equal(r2.updated_at, r1.updated_at, 'kein Reconcile-Write bei stable state');
});

test('reconcile entfernt stale Page (im order_json, aber nicht mehr in pages)', () => {
  const bookId = seedBook('stale-page');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  const p2 = seedPage(bookId, c1, 'P2');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p2 }] },
  ], 'test');
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(p1);

  const r = bookOrder.ensureTree(bookId);
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.deepEqual(c1Entry.children, [{ type: 'page', id: p2 }]);
});

test('reconcile filtert Duplikate im stored Tree (Korruptionsschutz)', () => {
  const bookId = seedBook('dup-stored');
  const c1 = seedChapter(bookId, 'C1');
  const p1 = seedPage(bookId, c1, 'P1');
  // Direct-Write korruptes JSON: P1 doppelt.
  db.prepare(`INSERT INTO book_order (book_id, order_json, updated_at, updated_by)
              VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'test')`).run(
    bookId,
    JSON.stringify([
      { type: 'chapter', id: c1, children: [{ type: 'page', id: p1 }, { type: 'page', id: p1 }] },
    ])
  );

  const r = bookOrder.ensureTree(bookId);
  const c1Entry = r.tree.find(e => e.type === 'chapter' && e.id === c1);
  assert.deepEqual(c1Entry.children, [{ type: 'page', id: p1 }], 'Duplikat weggefiltert');
});

test('reconcile: Page mit chapter_id zu geloeschtem Kapitel landet top-level', () => {
  const bookId = seedBook('orphan-chapter-id');
  const cVisible = seedChapter(bookId, 'C1');
  const cGhost = seedChapter(bookId, 'CGhost');
  const pOrphan = seedPage(bookId, cGhost, 'Orphan');
  // Overlay kennt cGhost nicht; pOrphan ist orphan im Sinn der Reconcile.
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cVisible, children: [] },
    { type: 'chapter', id: cGhost, children: [{ type: 'page', id: pOrphan }] },
  ], 'test');
  // Jetzt cGhost loeschen — pages.chapter_id wird via FK ON DELETE SET NULL
  // genullt, also ist die Page in DB top-level. Reconcile soll sie ohne
  // Stale-Referenz top-level einsortieren.
  db.prepare('DELETE FROM chapters WHERE chapter_id = ?').run(cGhost);
  assert.equal(
    db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(pOrphan).chapter_id,
    null,
    'FK ON DELETE SET NULL hat geklappt'
  );

  const r = bookOrder.ensureTree(bookId);
  const top = r.tree.find(e => e.type === 'page' && e.id === pOrphan);
  assert.ok(top, 'Page landet top-level wenn ihr Chapter weg ist');
  const ghostStillThere = r.tree.find(e => e.type === 'chapter' && e.id === cGhost);
  assert.equal(ghostStillThere, undefined, 'gelöschtes Kapitel wegfiltern');
});

test('bookTree initialisiert order_json beim ersten Aufruf', async () => {
  const bookId = seedBook('first-read');
  const c1 = seedChapter(bookId, 'C1');
  seedPage(bookId, c1, 'P1');

  assert.equal(bookOrder.getOrder(bookId), null, 'noch keine Row');
  await contentStore.bookTree(bookId);
  const r = bookOrder.getOrder(bookId);
  assert.ok(r?.tree?.length, 'Row jetzt initialisiert');
  assert.equal(r.tree[0].type, 'chapter');
  assert.equal(r.tree[0].id, c1);
});

test('bookTree: chapter_id im Output folgt order_json, nicht pages.chapter_id', async () => {
  const bookId = seedBook('chapter-id-override');
  const c1 = seedChapter(bookId, 'C1');
  // Page in DB top-level (chapter_id=null), aber order_json packt sie unter c1.
  const pTopInDb = seedPage(bookId, null, 'P');
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: c1, children: [{ type: 'page', id: pTopInDb }] },
  ], 'test');

  const tree = await contentStore.bookTree(bookId);
  const c1Out = tree.chapters.find(c => c.id === c1);
  assert.equal(c1Out.pages.length, 1);
  assert.equal(c1Out.pages[0].id, pTopInDb);
  assert.equal(c1Out.pages[0].chapter_id, c1, 'Output-chapter_id folgt Overlay-Bucket');
});

test('content-store bookTree liest order_json (Overlay)', async () => {
  const bookId = seedBook('overlay');
  const cA = seedChapter(bookId, 'A', 0);
  const cB = seedChapter(bookId, 'B', 1);
  const pA1 = seedPage(bookId, cA, 'A1', 0);
  const pA2 = seedPage(bookId, cA, 'A2', 1);
  // Stored order kehrt Kapitel + Seiten um.
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cB, children: [] },
    { type: 'chapter', id: cA, children: [{ type: 'page', id: pA2 }, { type: 'page', id: pA1 }] },
  ], 'test');

  const tree = await contentStore.bookTree(bookId);
  assert.equal(tree.chapters[0].id, cB);
  assert.equal(tree.chapters[1].id, cA);
  assert.deepEqual(tree.chapters[1].pages.map(p => p.id), [pA2, pA1]);
});

test('content-store bookTree: Sub-Kapitel als subchapters[] verschachtelt', async () => {
  const bookId = seedBook('nested-tree');
  const cTop = seedChapter(bookId, 'Top', 0);
  const cSub = seedChapter(bookId, 'Sub', 1);
  const pT1 = seedPage(bookId, cTop, 'T1', 0);
  const pS1 = seedPage(bookId, cSub, 'S1', 0);
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cTop, children: [
      { type: 'chapter', id: cSub, children: [{ type: 'page', id: pS1 }] },
      { type: 'page', id: pT1 },
    ]},
  ], 'test');

  const tree = await contentStore.bookTree(bookId);
  assert.equal(tree.chapters.length, 1);
  assert.equal(tree.chapters[0].id, cTop);
  assert.equal(tree.chapters[0].pages.length, 1);
  assert.equal(tree.chapters[0].pages[0].id, pT1);
  assert.equal(tree.chapters[0].subchapters.length, 1);
  assert.equal(tree.chapters[0].subchapters[0].id, cSub);
  assert.equal(tree.chapters[0].subchapters[0].pages[0].id, pS1);
});

test('content-store flattenTree: depth-first Seiten + chapterName Mapping', async () => {
  const bookId = seedBook('flatten');
  const cTop = seedChapter(bookId, 'Top', 0);
  const cSub = seedChapter(bookId, 'Sub', 1);
  const pT1 = seedPage(bookId, cTop, 'T1', 0);
  const pS1 = seedPage(bookId, cSub, 'S1', 0);
  const pTop = seedPage(bookId, null, 'TopPage', 0);
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cTop, children: [
      { type: 'page', id: pT1 },
      { type: 'chapter', id: cSub, children: [{ type: 'page', id: pS1 }] },
    ]},
    { type: 'page', id: pTop },
  ], 'test');

  const tree = await contentStore.bookTree(bookId);
  const flat = contentStore.flattenTree(tree);
  assert.deepEqual(flat.map(r => r.page.id), [pT1, pS1, pTop]);
  assert.deepEqual(flat.map(r => r.chapterName), ['Top', 'Sub', null]);
  assert.deepEqual(flat.map(r => r.depth), [1, 2, 0]);
});

test('getDescendantChapterIds: rekursive CTE liefert alle Nachfahren', () => {
  const bookId = seedBook('descendants');
  const cTop = seedChapter(bookId, 'Top', 0);
  const cSub = seedChapter(bookId, 'Sub', 1);
  const cSubSub = seedChapter(bookId, 'SubSub', 2);
  const cOther = seedChapter(bookId, 'Other', 3);
  bookOrder.putOrder(bookId, [
    { type: 'chapter', id: cTop, children: [
      { type: 'chapter', id: cSub, children: [
        { type: 'chapter', id: cSubSub, children: [] },
      ]},
    ]},
    { type: 'chapter', id: cOther, children: [] },
  ], 'test');

  const desc = bookOrder.getDescendantChapterIds(cTop).sort();
  assert.deepEqual(desc, [cSub, cSubSub].sort());

  const inclSelf = bookOrder.getDescendantChapterIds(cTop, { includeSelf: true }).sort();
  assert.deepEqual(inclSelf, [cTop, cSub, cSubSub].sort());

  assert.deepEqual(bookOrder.getDescendantChapterIds(cOther), []);
});

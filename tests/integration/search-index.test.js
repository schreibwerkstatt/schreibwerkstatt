'use strict';
// End-to-End-Test fuer den FTS5-Search-Index.
// Indexiert Pages/Chapters/Books/Figures via lib/search Upserts, fragt zurueck
// und prueft ACL-Filter, BM25-Reihenfolge, Trigram-Fallback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'search-index-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require.cache[key];
  }
  require('../../db/connection');
  require('../../db/migrations').runMigrations();
  return {
    dir,
    db: require('../../db/connection').db,
    search: require('../../lib/search'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_e) {} },
  };
}

function _seedBook(db, name) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO books (name, slug, owner_email, created_at, updated_at)
    VALUES (?, ?, 'a@b', ?, ?)
  `).run(name, name.toLowerCase().replace(/\s+/g, '-'), now, now).lastInsertRowid;
}

function _seedPage(db, bookId, name, html) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, name, html, now, now).lastInsertRowid;
}

function _seedFigure(db, bookId, name, beschreibung) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO figures (book_id, fig_id, name, beschreibung, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, 'f' + name, name, beschreibung, now).lastInsertRowid;
}

test('upsertPage + query: einfacher Treffer', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Testbuch');
    const pageId = _seedPage(db, bookId, 'Erste Seite', '<p>Hallo Welt</p>');
    search.upsertPage(pageId);

    const result = search.query('hallo', { allowedBookIds: [bookId] });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].kind, 'page');
    assert.equal(result.hits[0].entity_id, pageId);
    assert.match(result.hits[0].snippet || '', /Hallo/);
  } finally { teardown(); }
});

test('upsertBookMeta: Klappentext aus book_publication ist auffindbar', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Testbuch');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO book_publication (book_id, description, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(bookId, '<p>Ein Leuchtturmwärter verschwindet.</p>', now, now);
    search.upsertBookMeta(bookId);

    const result = search.query('leuchtturmwärter', { allowedBookIds: [bookId] });
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].kind, 'book');
  } finally { teardown(); }
});

test('Title BM25-Boost: Title-only-Treffer rankt vor Body-only-Treffer', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    // Body-Hit hat das Suchwort nur im Body, Title-Hit nur im Titel — Title-Boost
    // 5x soll Title-only vor Body-only ranken.
    const bodyHit = _seedPage(db, bookId, 'Erste Seite', '<p>Im Text steht Schwert.</p>');
    const titleHit = _seedPage(db, bookId, 'Schwert', '<p>nur kurz.</p>');
    search.upsertPage(bodyHit);
    search.upsertPage(titleHit);

    const result = search.query('schwert', { allowedBookIds: [bookId] });
    assert.equal(result.hits.length, 2);
    // BM25 in SQLite ist negativ (kleiner = besser). rank-Werte vergleichen.
    const titleRank = result.hits.find(h => h.entity_id === titleHit).rank;
    const bodyRank = result.hits.find(h => h.entity_id === bodyHit).rank;
    assert.ok(titleRank <= bodyRank,
      `Title-Boost: titleRank ${titleRank} muss <= bodyRank ${bodyRank} sein`);
  } finally { teardown(); }
});

test('Umlaut-Folding: "ueber" matched "über" (remove_diacritics=2)', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    const pageId = _seedPage(db, bookId, 'Über Wölfe', '<p>Geschichten über Wölfe und Bären.</p>');
    search.upsertPage(pageId);

    const r1 = search.query('wolfe', { allowedBookIds: [bookId] });
    assert.ok(r1.hits.length >= 1, 'wolfe matched Wölfe');
    const r2 = search.query('uber', { allowedBookIds: [bookId] });
    assert.ok(r2.hits.length >= 1, 'uber matched über');
  } finally { teardown(); }
});

test('ACL-Filter: allowedBookIds=[bookA] blendet bookB aus', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookA = _seedBook(db, 'Buch A');
    const bookB = _seedBook(db, 'Buch B');
    const pageA = _seedPage(db, bookA, 'A1', '<p>geheimwort</p>');
    const pageB = _seedPage(db, bookB, 'B1', '<p>geheimwort</p>');
    search.upsertPage(pageA);
    search.upsertPage(pageB);

    const onlyA = search.query('geheimwort', { allowedBookIds: [bookA] });
    assert.equal(onlyA.hits.length, 1);
    assert.equal(onlyA.hits[0].entity_id, pageA);

    const both = search.query('geheimwort', { allowedBookIds: [bookA, bookB] });
    assert.equal(both.hits.length, 2);

    const none = search.query('geheimwort', { allowedBookIds: [] });
    assert.equal(none.hits.length, 0);
  } finally { teardown(); }
});

test('kind-Filter: kinds=[page] zeigt keine Figuren', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    const pageId = _seedPage(db, bookId, 'Brunhilde', '<p>...</p>');
    const figId = _seedFigure(db, bookId, 'Brunhilde', 'Eine Heldin.');
    search.upsertPage(pageId);
    search.upsertFigure(figId);

    const onlyPages = search.query('brunhilde', { allowedBookIds: [bookId], kinds: ['page'] });
    assert.equal(onlyPages.hits.length, 1);
    assert.equal(onlyPages.hits[0].kind, 'page');

    const onlyFigures = search.query('brunhilde', { allowedBookIds: [bookId], kinds: ['figure'] });
    assert.equal(onlyFigures.hits.length, 1);
    assert.equal(onlyFigures.hits[0].kind, 'figure');

    const all = search.query('brunhilde', { allowedBookIds: [bookId] });
    assert.equal(all.hits.length, 2);
  } finally { teardown(); }
});

test('upsert is idempotent: zweimal aufrufen → keine Doppel-Hits', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    const pageId = _seedPage(db, bookId, 'Titel', '<p>Wort</p>');
    search.upsertPage(pageId);
    search.upsertPage(pageId);
    search.upsertPage(pageId);

    const result = search.query('wort', { allowedBookIds: [bookId] });
    assert.equal(result.hits.length, 1);
  } finally { teardown(); }
});

test('remove + removeAllForBook: drop hits', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    const pageId = _seedPage(db, bookId, 'Titel', '<p>Suchwort</p>');
    search.upsertPage(pageId);
    assert.equal(search.query('suchwort', { allowedBookIds: [bookId] }).hits.length, 1);

    search.remove('page', pageId);
    assert.equal(search.query('suchwort', { allowedBookIds: [bookId] }).hits.length, 0);

    search.upsertPage(pageId);
    assert.equal(search.query('suchwort', { allowedBookIds: [bookId] }).hits.length, 1);

    search.removeAllForBook(bookId);
    assert.equal(search.query('suchwort', { allowedBookIds: [bookId] }).hits.length, 0);
  } finally { teardown(); }
});

test('reindexAll: leert + neu aus den DB-Tabellen', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Reindex-Buch');
    const pageId = _seedPage(db, bookId, 'Reindex Page', '<p>Reindex Body Text</p>');
    // Erstmal NICHT indexieren — Index ist leer.
    assert.equal(search.query('reindex', { allowedBookIds: [bookId] }).hits.length, 0);

    const counts = search.reindexAll();
    assert.ok(counts.page >= 1);
    assert.ok(counts.book >= 1);

    const result = search.query('reindex', { allowedBookIds: [bookId] });
    assert.ok(result.hits.length >= 1);
  } finally { teardown(); }
});

test('Trigram-Fallback: Single-Word ohne FTS-Treffer → Trigram-Match auf Titel', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    // Titel "Schwertkampf" — Suche nach "schwertk" ist Substring, kein
    // ganzes Wort -> FTS5-unicode61 findet's nicht, Trigram schon.
    const pageId = _seedPage(db, bookId, 'Schwertkampf', '<p>nichts.</p>');
    search.upsertPage(pageId);

    const result = search.query('schwertk', { allowedBookIds: [bookId] });
    // Entweder normal (Prefix-like) oder via Fallback — Hauptsache Treffer.
    assert.ok(result.hits.length >= 1);
  } finally { teardown(); }
});

test('Empty-Title-Empty-Body wird nicht indexiert', () => {
  const { db, search, teardown } = _bootstrap();
  try {
    const bookId = _seedBook(db, 'Buch');
    const pageId = _seedPage(db, bookId, '', '');
    search.upsertPage(pageId);
    // search_index sollte keine Row fuer diese Page haben — d.h. eine
    // beliebige Query findet nichts ueber sie. Direkter Count-Check:
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM search_index WHERE kind = ? AND entity_id = ?'
    ).get('page', pageId);
    assert.equal(row.n, 0);
  } finally { teardown(); }
});

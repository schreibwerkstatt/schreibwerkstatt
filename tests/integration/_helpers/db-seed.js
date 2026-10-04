'use strict';
// Seeder fuer Integration-Tests. Schreibt Buecher/Kapitel/Seiten direkt in
// die lokalen SQLite-Tabellen — Content-Store-Facade liest sie dann von dort.

function _seedDb({ chapters, pages, pageBodies = {}, books = [] }) {
  const { db } = require('../../../db/connection');
  const nowIso = new Date().toISOString();
  const insBook = db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
  `);
  const insChap = db.prepare(`
    INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET
      book_id=excluded.book_id, chapter_name=excluded.chapter_name,
      position=excluded.position, updated_at=excluded.updated_at
  `);
  // local_updated_at bewusst NULL — content-store-Reader nutzt dann
  // pages.updated_at (Test-Fixture-Wert) als Single-Source-of-Truth fuer
  // updated_at; Caches in der Pipeline koennen so per page.updated_at
  // invalidiert werden.
  const insPage = db.prepare(`
    INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, local_updated_at, body_html)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      book_id=excluded.book_id, page_name=excluded.page_name, chapter_id=excluded.chapter_id,
      position=excluded.position,
      updated_at=excluded.updated_at, local_updated_at=NULL,
      body_html=excluded.body_html
  `);

  const chIds = new Set();
  db.transaction(() => {
    const bookIds = new Set();
    for (const c of chapters) if (c.book_id) bookIds.add(c.book_id);
    for (const p of pages) if (p.book_id) bookIds.add(p.book_id);
    for (const b of books) if (b?.id) bookIds.add(b.id);
    for (const bid of bookIds) {
      const b = books.find(x => x.id === bid);
      insBook.run(bid, b?.name || `Test-Book-${bid}`, nowIso, nowIso);
    }
    for (const c of chapters) {
      const pos = c.position ?? 0;
      insChap.run(c.id, c.book_id, c.name || '', pos, c.updated_at || nowIso);
      chIds.add(c.id);
    }
    for (const p of pages) {
      const knownCh = p.chapter_id && chIds.has(p.chapter_id) ? p.chapter_id : null;
      const pos = p.position ?? 0;
      const body = pageBodies[p.id] || '';
      insPage.run(p.id, p.book_id, p.name || '', knownCh, pos, p.updated_at || nowIso, body);
    }
  })();
}

function _wipeDb() {
  const { db } = require('../../../db/connection');
  db.transaction(() => {
    db.prepare('DELETE FROM pages').run();
    db.prepare('DELETE FROM chapters').run();
    db.prepare('DELETE FROM books').run();
  })();
}

function setBook({ chapters = [], pages = [], pageBodies = {}, books = [] } = {}) {
  _seedDb({ chapters, pages, pageBodies, books });
}

function reset() { _wipeDb(); }

module.exports = { setBook, reset };

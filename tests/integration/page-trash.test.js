'use strict';
// Papierkorb geloeschter Seiten (lib/content-store/backends/localdb-delete.js +
// contentStore.restoreDeletedPage). Verifiziert, dass
//   - deletePage Inhalt, Kapitel und referenzierte Bilder VOR dem CASCADE sichert,
//   - restoreDeletedPage die Seite im alten Kapitel neu anlegt und die Bild-Refs
//     auf die neu eingefuegten BLOBs umschreibt,
//   - ein zweiter Restore und ein fremdes Buch abgewiesen werden,
//   - Alt-Eintraege ohne gesicherten Inhalt nicht wiederherstellbar sind,
//   - ein geloeschtes Kapitel die Wiederherstellung auf die Buch-Ebene verlegt.

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
test.before(() => {
  ctx = bootstrap();
  ctx.contentStore = require('../../lib/content-store');
  ctx.connection = require('../../db/connection');
  ctx.pageImages = require('../../db/page-images');
});
test.after(() => { ctx.cleanup(); });

const db = () => ctx.connection.db;

function _seedBook(name = 'Papierkorb-Buch') {
  const now = new Date().toISOString();
  return db().prepare(`
    INSERT INTO books (name, description, created_at, updated_at, owner_email) VALUES (?, '', ?, ?, NULL)
  `).run(name, now, now).lastInsertRowid;
}

function _seedChapter(bookId, name = 'Kapitel 1') {
  const now = new Date().toISOString();
  return db().prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, updated_at) VALUES (?, ?, 0, ?)
  `).run(bookId, name, now).lastInsertRowid;
}

function _seedPage(bookId, chapterId, name, html) {
  const now = new Date().toISOString();
  return db().prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(bookId, chapterId, name, html, now, now).lastInsertRowid;
}

const _trashEntry = (pageId) => db().prepare('SELECT * FROM page_deletions WHERE page_id = ?').get(pageId);

test('deletePage sichert Inhalt, Kapitel und Bilder; Restore legt die Seite mit Bildern neu an', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId);
  const pageId = _seedPage(bookId, chapterId, 'Verlorene Szene', '<p>Erster Absatz</p>');
  const bytes = Buffer.from('fake-jpeg-bytes');
  const imgId = ctx.pageImages.insertPageImage({ pageId, mime: 'image/jpeg', width: 10, height: 10, image: bytes });
  db().prepare('UPDATE pages SET body_html = ? WHERE page_id = ?')
    .run(`<p>Erster Absatz</p><p><img src="/content/page-image/${imgId}"></p>`, pageId);

  await ctx.contentStore.deletePage(pageId, null, { deletedBy: 'alice@example.com' });
  assert.equal(ctx.pageImages.getPageImage(imgId), undefined, 'Bild per CASCADE weg');

  const entry = _trashEntry(pageId);
  assert.match(entry.body_html, /Erster Absatz/);
  assert.equal(entry.chapter_id, chapterId);
  assert.equal(JSON.parse(entry.images_json)[0].oldId, imgId);

  const list = ctx.contentStore.listPageTrash(bookId);
  assert.equal(list.length, 1);
  assert.equal(list[0].page_name, 'Verlorene Szene');
  assert.equal(list[0].chapter_name, 'Kapitel 1');

  const restored = await ctx.contentStore.restoreDeletedPage(entry.id, bookId, null);
  assert.notEqual(restored.id, pageId, 'neue page_id');
  assert.equal(restored.chapter_id, chapterId);
  const page = await ctx.contentStore.loadPage(restored.id);
  assert.equal(page.name, 'Verlorene Szene');
  assert.match(page.html, /Erster Absatz/);
  const newImgId = Number(page.html.match(/\/content\/page-image\/(\d+)/)[1]);
  assert.notEqual(newImgId, imgId, 'Bild-Ref umgeschrieben');
  const img = ctx.pageImages.getPageImage(newImgId);
  assert.equal(img.page_id, restored.id);
  assert.deepEqual(Buffer.from(img.image), bytes);

  assert.equal(ctx.contentStore.listPageTrash(bookId).length, 0, 'aus der Liste raus');
  assert.ok(_trashEntry(pageId).restored_at, 'Zeile bleibt fuer den Client-Sync');
  await assert.rejects(() => ctx.contentStore.restoreDeletedPage(entry.id, bookId, null), { code: 'ALREADY_RESTORED' });
});

test('Restore eines Eintrags aus einem anderen Buch → TRASH_NOT_FOUND', async () => {
  const bookA = _seedBook('A');
  const bookB = _seedBook('B');
  const pageId = _seedPage(bookA, null, 'Seite A', '<p>A</p>');
  await ctx.contentStore.deletePage(pageId, null);
  const entry = _trashEntry(pageId);
  await assert.rejects(() => ctx.contentStore.restoreDeletedPage(entry.id, bookB, null), { code: 'TRASH_NOT_FOUND' });
  assert.equal(_trashEntry(pageId).restored_at, null);
});

test('Alt-Eintrag ohne gesicherten Inhalt (vor Mig 299) → nicht in der Liste, nicht wiederherstellbar', async () => {
  const bookId = _seedBook();
  const pageId = _seedPage(bookId, null, 'Alt', '<p>weg</p>');
  await ctx.contentStore.deletePage(pageId, null);
  db().prepare('UPDATE page_deletions SET body_html = NULL, images_json = NULL WHERE page_id = ?').run(pageId);
  const entry = _trashEntry(pageId);
  assert.equal(ctx.contentStore.listPageTrash(bookId).length, 0);
  await assert.rejects(() => ctx.contentStore.restoreDeletedPage(entry.id, bookId, null), { code: 'TRASH_NOT_FOUND' });
});

test('Kapitel inzwischen geloescht → Wiederherstellung auf Buch-Ebene', async () => {
  const bookId = _seedBook();
  const chapterId = _seedChapter(bookId, 'Faellt weg');
  const pageId = _seedPage(bookId, chapterId, 'Waise', '<p>Text</p>');
  await ctx.contentStore.deletePage(pageId, null);
  await ctx.contentStore.deleteChapter(chapterId, null);
  const entry = _trashEntry(pageId);
  assert.equal(entry.chapter_id, null, 'FK SET NULL');
  const restored = await ctx.contentStore.restoreDeletedPage(entry.id, bookId, null);
  assert.equal(restored.chapter_id, null);
  assert.match((await ctx.contentStore.loadPage(restored.id)).html, /Text/);
});

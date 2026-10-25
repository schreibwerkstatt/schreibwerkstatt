'use strict';
// Delete-Operationen fuer das localdb-Backend. Ausgelagert, damit localdb.js
// unter dem LOC-Cap bleibt.
//
// Seiten werden hart geloescht (page_revisions + page_images gehen per CASCADE
// mit). Damit eine versehentlich geloeschte Seite zurueckkommt, sichert
// `deletePage` Inhalt, Kapitel und referenzierte Bilder im Loesch-Log
// `page_deletions` — der Papierkorb. `restorePage` legt daraus eine neue Seite an.

const { db } = require('../../../db/connection');
const { collectReferencedImages } = require('../../../db/page-images');
const { _nowIso, _notFound } = require('./localdb-util');

// Bilder MUESSEN vor dem DELETE gelesen werden — danach hat das CASCADE sie
// schon entfernt.
function _imagesJson(pageId, bookId, html) {
  const list = collectReferencedImages(new Map([[pageId, html]]), bookId).get(pageId);
  return list?.length ? JSON.stringify(list) : null;
}

async function deletePage(pageId, { deletedBy = null, deviceId = null } = {}) {
  const page = db.prepare(`
    SELECT page_id, book_id, chapter_id, page_name, body_html, last_editor_device_id
      FROM pages WHERE page_id = ?
  `).get(pageId);
  if (!page) throw _notFound('Page', pageId);
  const bodyHtml = page.body_html || '';
  const imagesJson = _imagesJson(pageId, page.book_id, bodyHtml);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO page_deletions (book_id, page_id, page_name, deleted_at, deleted_by_email, device_id,
                                  body_html, chapter_id, images_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      page.book_id,
      page.page_id,
      page.page_name || '',
      _nowIso(),
      deletedBy || null,
      deviceId || page.last_editor_device_id || null,
      bodyHtml,
      page.chapter_id,
      imagesJson,
    );
    // Ideen am Abschnitt werden Buch-Ideen statt mitzufallen (FK CASCADE):
    // eine Pendenz — auch eine verworfene — verschwindet nie still, und die
    // Ideen sind user-privat, der Loeschende saehe fremde gar nicht.
    db.prepare('UPDATE ideen SET page_id = NULL WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM pages WHERE page_id = ?').run(pageId);
  });
  tx();
  return { ok: true, bookId: page.book_id, pageName: page.page_name || '' };
}

// Papierkorb eines Buchs: wiederherstellbare, noch nicht wiederhergestellte
// Loeschungen, juengste zuerst. Ohne Inhalt und Bilder (Liste, nicht Vorschau).
function listTrash(bookId) {
  return db.prepare(`
    SELECT d.id, d.page_id, d.page_name, d.deleted_at, d.deleted_by_email,
           u.display_name AS deleted_by_name,
           d.chapter_id, c.chapter_name, length(d.body_html) AS html_len,
           (d.images_json IS NOT NULL) AS has_images
      FROM page_deletions d
      LEFT JOIN chapters c ON c.chapter_id = d.chapter_id
      LEFT JOIN app_users u ON u.email = d.deleted_by_email COLLATE NOCASE
     WHERE d.book_id = ? AND d.body_html IS NOT NULL AND d.restored_at IS NULL
     ORDER BY d.deleted_at DESC, d.id DESC
  `).all(bookId);
}

function getTrashEntry(id) {
  return db.prepare(`
    SELECT d.id, d.book_id, d.page_id, d.page_name, d.body_html, d.chapter_id, d.images_json,
           d.restored_at, c.book_id AS chapter_book_id
      FROM page_deletions d
      LEFT JOIN chapters c ON c.chapter_id = d.chapter_id
     WHERE d.id = ?
  `).get(id);
}

// Atomar „restored" setzen; false, wenn ein paralleler Restore schneller war.
function markRestored(id) {
  return db.prepare('UPDATE page_deletions SET restored_at = ? WHERE id = ? AND restored_at IS NULL')
    .run(_nowIso(), id).changes > 0;
}

function unmarkRestored(id) {
  db.prepare('UPDATE page_deletions SET restored_at = NULL WHERE id = ?').run(id);
}

module.exports = { deletePage, listTrash, getTrashEntry, markRestored, unmarkRestored };

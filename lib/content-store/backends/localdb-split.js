'use strict';
// Abschnitt teilen: eine Seite wird an einer Blockgrenze in zwei Seiten
// zerlegt. Ausgelagert, damit localdb.js unter dem LOC-Cap bleibt.
//
// Eine Transaktion um alles, was die Struktur traegt: Kopf zurueckschreiben
// (mit Optimistic-Concurrency-Guard wie savePage), Schwanz als neue Seite im
// selben Kapitel anlegen, die neue Seite in book_order direkt hinter die
// Ausgangsseite haengen (putOrder materialisiert die Positionen lueckenlos, die
// Folgeseiten ruecken nach), und die nur noch vom Schwanz referenzierten
// Manuskript-Bilder der neuen Seite zuordnen. Revisionen, Such-/Beleg-/
// Verweis-Index und das Buch-Event zieht die Facade nach.

const { db } = require('../../../db/connection');
const bookOrder = require('../../../db/book-order');
const { _cleanHtmlSafe, loadPage } = require('./localdb');

function _nowIso() { return new Date().toISOString(); }

function _err(code, status, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status;
  return e;
}

const BID_RE = /\sdata-bid="([^"]*)"/g;

function _bids(html) {
  const out = new Set();
  let m;
  BID_RE.lastIndex = 0;
  while ((m = BID_RE.exec(html || ''))) out.add(m[1]);
  return out;
}

// Ein Block, der in Kopf UND Schwanz mit derselben data-bid stuende (der
// Client teilt einen Absatz am Caret: beide Haelften stammen vom selben
// Element), verankerte zwei Seiten unter einer ID — findPagesByBlockIds und
// die Kommentar-Anker naehmen dann die erste. Der Kopf behaelt die ID, der
// Schwanz bekommt am Chokepoint (ensureBlockIds) eine frische.
function _dropSharedBids(tailHtml, headHtml) {
  const head = _bids(headHtml);
  if (!head.size) return tailHtml;
  return String(tailHtml).replace(BID_RE, (full, bid) => (head.has(bid) ? '' : full));
}

const PAGE_IMG_REF = /\/content\/page-image\/(\d+)/g;
function _imageIds(html) {
  const out = new Set();
  let m;
  PAGE_IMG_REF.lastIndex = 0;
  while ((m = PAGE_IMG_REF.exec(html || ''))) out.add(parseInt(m[1], 10));
  return out;
}

// Neue Seite in order_json direkt hinter die Ausgangsseite setzen. ensureTree
// hat sie (per pages.chapter_id) bereits ans Ende ihres Kapitels gehaengt.
function _placePageAfter(bookId, pageId, anchorId) {
  const ordered = bookOrder.ensureTree(bookId);
  const tree = JSON.parse(JSON.stringify(ordered?.tree || []));
  const take = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'page' && n.id === pageId) return nodes.splice(i, 1)[0];
      if (n.type === 'chapter') {
        const hit = take(n.children || []);
        if (hit) return hit;
      }
    }
    return null;
  };
  const insert = (nodes, node) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'page' && n.id === anchorId) { nodes.splice(i + 1, 0, node); return true; }
      if (n.type === 'chapter' && insert(n.children || [], node)) return true;
    }
    return false;
  };
  const node = take(tree) || { type: 'page', id: pageId };
  if (!insert(tree, node)) return;
  // updated_by bleibt beim letzten echten Umsortierer — Teilen ist kein Reorder.
  bookOrder.putOrder(bookId, tree, ordered?.updated_by ?? null);
}

/**
 * @param {number} pageId
 * @param {{ headHtml: string, tailHtml: string, newName: string,
 *           expectedUpdatedAt?: string|null, userEmail?: string|null,
 *           deviceId?: string|null }} opts
 * @returns {Promise<{ head: object, tail: object }>}
 */
async function splitPage(pageId, { headHtml, tailHtml, newName, expectedUpdatedAt = null, userEmail = null, deviceId = null }) {
  const head = _cleanHtmlSafe(headHtml);
  const tail = _cleanHtmlSafe(_dropSharedBids(tailHtml, head));
  const now = _nowIso();
  let newId = null;

  db.transaction(() => {
    const row = db.prepare(
      'SELECT page_id, book_id, chapter_id, updated_at, last_editor_email FROM pages WHERE page_id = ?'
    ).get(pageId);
    if (!row) throw _err('NOT_FOUND', 404, `Page ${pageId} not found`);
    if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) {
      const e = _err('PAGE_CONFLICT', 409, `Page ${pageId} updated by another writer`);
      e.serverUpdatedAt = row.updated_at;
      e.serverEditorEmail = row.last_editor_email;
      throw e;
    }
    db.prepare(`
      UPDATE pages SET body_html = ?, last_editor_email = ?, last_editor_device_id = ?,
                       local_updated_at = ?, updated_at = ?
       WHERE page_id = ?
    `).run(head, userEmail, deviceId, now, now, pageId);
    const pos = db.prepare(
      'SELECT COALESCE(MAX(position), 0) AS m FROM pages WHERE book_id = ?'
    ).get(row.book_id);
    newId = db.prepare(`
      INSERT INTO pages (book_id, chapter_id, page_name, body_html, position,
                         last_editor_email, last_editor_device_id,
                         updated_at, local_updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.book_id, row.chapter_id || null, newName, tail, (pos?.m || 0) + 1,
      userEmail, deviceId, now, now, now).lastInsertRowid;

    // Bilder gehoeren per FK (CASCADE) einer Seite. Was nur noch der Schwanz
    // zeigt, zieht mit — sonst risse ein spaeteres Loeschen der Ausgangsseite
    // die Bilder aus dem neuen Abschnitt.
    const headImgs = _imageIds(head);
    const moveImg = db.prepare('UPDATE page_images SET page_id = ? WHERE id = ? AND page_id = ?');
    for (const id of _imageIds(tail)) {
      if (!headImgs.has(id)) moveImg.run(newId, id, pageId);
    }

    _placePageAfter(row.book_id, newId, pageId);
  })();

  return { head: await loadPage(pageId), tail: await loadPage(newId) };
}

module.exports = { splitPage, _dropSharedBids };

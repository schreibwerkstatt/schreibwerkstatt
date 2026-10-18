'use strict';
// Vom User im Notebook-Editor eingefuegte Manuskript-Bilder. An die Seite
// gebunden (CASCADE). Geschrieben von der Upload-Route POST /content/pages/:id/images
// (Bytes vorher durch sharp normalisiert), gelesen von der Stream-Route
// GET /content/page-image/:id sowie direkt von den Export-Buildern (PDF/EPUB/DOCX),
// der Fassungs-/Migrations-Serialisierung und dem Share-Reader.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _insert = db.prepare(`
  INSERT INTO page_images (page_id, mime, width, height, size, image, created_at)
  VALUES (@page_id, @mime, @width, @height, @size, @image, ${NOW_ISO_SQL})
`);

function insertPageImage({ pageId, mime, width, height, size, image }) {
  const r = _insert.run({
    page_id: pageId,
    mime: mime || 'image/jpeg',
    width: width || null,
    height: height || null,
    size: size || (image ? image.length : 0),
    image,
  });
  return r.lastInsertRowid;
}

// Bild + book_id/chapter_id (ueber die Seite) fuer den ACL- bzw. Share-Scope-Check.
const _get = db.prepare(`
  SELECT pi.id, pi.page_id, pi.mime, pi.width, pi.height, pi.size, pi.image, p.book_id, p.chapter_id
  FROM page_images pi
  JOIN pages p ON p.page_id = pi.page_id
  WHERE pi.id = ?
`);

function getPageImage(id) {
  return _get.get(id);
}

// Bild nur, wenn es zu einer Seite von `bookId` gehoert. Pflicht fuer jeden Pfad,
// der Bild-Bytes aus einer /content/page-image/<id>-Referenz im Seiten-HTML zieht
// (Export, Fassung, Papierkorb): die ID steht im vom User geschriebenen HTML und
// kann auf das Bild eines fremden Buchs zeigen.
function getBookPageImage(id, bookId) {
  const row = _get.get(id);
  const b = Number(bookId);
  if (!row || !Number.isInteger(b) || b <= 0 || Number(row.book_id) !== b) return null;
  return row;
}



// ── Snapshot-/Migrations-Serialisierung ──────────────────────────────────────
// Die BLOBs muessen bei Fassungs-Restore und .swbook-Migration mitwandern, sonst
// brechen die /content/page-image/:id-Referenzen (Restore vergibt neue page_ids;
// Migration transferiert in eine fremde Instanz). Beide Pfade teilen dieselbe
// node-Tree-Serialisierung — die Bilder haengen als base64 am Page-Node.

const PAGE_IMG_REF = /\/content\/page-image\/(\d+)/g;

// Pro Seite die im HTML referenzierten Bild-BLOBs als base64 sammeln.
// Map pageId -> [{ oldId, mime, width, height, b64 }]. Nur tatsaechlich
// referenzierte IDs (keine verwaisten Rows nach HTML-Loeschung) und nur Bilder
// aus `bookId` (siehe getBookPageImage).
function collectReferencedImages(htmlById, bookId) {
  const byPage = new Map();
  for (const [pageId, html] of htmlById.entries()) {
    if (!html || html.indexOf('/content/page-image/') === -1) continue;
    const ids = new Set();
    let m; PAGE_IMG_REF.lastIndex = 0;
    while ((m = PAGE_IMG_REF.exec(html))) ids.add(parseInt(m[1], 10));
    const list = [];
    for (const id of ids) {
      const row = getBookPageImage(id, bookId);
      if (row && row.image) {
        list.push({ oldId: id, mime: row.mime, width: row.width, height: row.height, b64: row.image.toString('base64') });
      }
    }
    if (list.length) byPage.set(pageId, list);
  }
  return byPage;
}

// Nach dem Neu-Anlegen einer Seite (Restore/Import): mitgefuehrte Bild-BLOBs
// unter der neuen page_id neu einfuegen und die /content/page-image/<oldId>-Refs
// im HTML auf die neuen IDs umschreiben. Gibt das umgeschriebene HTML zurueck,
// oder null wenn nichts zu tun/umzuschreiben war.
function restorePageImages(newPageId, html, images) {
  if (!Array.isArray(images) || !images.length) return null;
  const idMap = new Map();
  for (const im of images) {
    if (!im || !im.b64) continue;
    try {
      const buf = Buffer.from(im.b64, 'base64');
      const newId = insertPageImage({
        pageId: newPageId, mime: im.mime, width: im.width, height: im.height,
        size: buf.length, image: buf,
      });
      if (im.oldId != null) idMap.set(String(im.oldId), newId);
    } catch { /* einzelnes Bild non-fatal ueberspringen */ }
  }
  if (!idMap.size || !html) return null;
  const out = html.replace(/\/content\/page-image\/(\d+)/g, (m, id) => {
    const n = idMap.get(String(id));
    return n ? `/content/page-image/${n}` : m;
  });
  return out === html ? null : out;
}

module.exports = {
  insertPageImage, getPageImage, getBookPageImage, collectReferencedImages, restorePageImages,
};

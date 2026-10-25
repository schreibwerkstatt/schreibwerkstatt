'use strict';

// Adapter: Fassungs-`content_json` (book_snapshots) -> Export-Bundle.
//
// Reader, alle Format-Builder (lib/export-builders/*) und der PDF-Render
// (lib/pdf-render) arbeiten gegen dieselbe Struktur, die sonst lib/load-contents
// aus dem Live-Buch baut:
//   { scope:'book', book:{ id, name, slug, description }, groups:[…] }
//   groups = [{ chapterId, chapter:{ id, name, parent_chapter_id, slug }|null,
//               pages:[{ p:{ id, name, slug }, pd:{ html } }] }]
//
// Hier wird dieselbe Form aus dem selbsttragenden Snapshot-Tree gebaut
// (buildBookJson-Format aus lib/book-bundle.js: { book, tree:[node…] } mit
// Seiten-HTML inline), damit eine Fassung exportiert/gelesen werden kann, ohne
// den aktuellen Buchstand anzufassen.
//
// Pure — keine DB, kein Express. node:test-bar.

const crypto = require('crypto');
const { slugify } = require('./slug');

// Kurzer Inhalts-Hash eines Bild-BLOBs (Cover/Autorfoto). Vergleich und Drift
// erkennen damit ein ausgetauschtes Bild, nicht nur Zugabe/Wegnahme.
function imageHash(buf) {
  if (!buf || !buf.length) return null;
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// /content/page-image/<oldId>-Refs im Snapshot-HTML zu selbsttragenden data:-URIs
// umschreiben (Bytes aus node.images). Pure — die base64 liegt bereits im Node.
function _inlineSnapshotImages(html, images) {
  if (!html || !Array.isArray(images) || !images.length) return html || '';
  if (html.indexOf('/content/page-image/') === -1) return html;
  const byId = new Map(images.map(im => [String(im.oldId), im]));
  return html.replace(/\/content\/page-image\/(\d+)/g, (m, id) => {
    const im = byId.get(String(id));
    return im && im.b64 ? `data:${im.mime || 'image/jpeg'};base64,${im.b64}` : m;
  });
}

// Node-Shapes (lib/book-bundle.js):
//   { type:'chapter', name, srcId, excluded?, children:[node…] }
//   { type:'page',    name, html, srcId, images?:[{oldId,mime,width,height,b64}] }
//
// Manuskript-Bilder: die im Seiten-HTML referenzierten /content/page-image/:id
// zeigen auf page_images-Rows, die nach einem Restore/einer Aenderung nicht mehr
// existieren muessen. Der Snapshot traegt die Bild-BLOBs aber selbst (node.images,
// base64) — beim Export werden die Refs deshalb zu selbsttragenden data:-URIs
// umgeschrieben (die Builder loesen sowohl /content/page-image als auch data: auf).
//
// Gruppierung spiegelt lib/load-contents.js#_groupByChapter: pro zusammen-
// haengendem Kapitel-Lauf eine Gruppe; kapitellose Top-Seiten je eigene
// chapterId:null-Gruppe; ein Kapitel ohne eigene Seiten mit Text im Teilbaum
// als Ueberschriften-Gruppe (`pages: []`). Reihenfolge = Lesereihenfolge
// (depth-first).
function snapshotToBundle(content, { bookId = null, bookName = '', bookDescription = '' } = {}) {
  const nodes = Array.isArray(content?.tree) ? content.tree : [];
  const groups = [];
  let synthChapterId = 0; // synthetische, in sich konsistente Kapitel-IDs

  function walk(list, parentChapterId, parentChapter) {
    let run = null; // aktuelle Seiten-Gruppe innerhalb dieses Kapitels
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;

      if (node.type === 'page') {
        const page = {
          p: {
            id: Number.isFinite(node.srcId) ? node.srcId : null,
            name: typeof node.name === 'string' ? node.name : '',
            slug: slugify(typeof node.name === 'string' ? node.name : ''),
          },
          pd: { html: _inlineSnapshotImages(typeof node.html === 'string' ? node.html : '', node.images) },
        };
        if (parentChapterId == null) {
          // Kapitellose Top-Seite: eigene Gruppe (kein Lauf).
          groups.push({ chapterId: null, chapter: null, pages: [page] });
          run = null;
        } else {
          if (!run) {
            run = { chapterId: parentChapterId, chapter: parentChapter, pages: [] };
            groups.push(run);
          }
          run.pages.push(page);
        }
      } else if (node.type === 'chapter') {
        // Aus dem Export ausgeschlossene Kapitel (chapters.excluded, kaskadiert auf
        // Unterkapitel) fallen weg wie im Live-Export (lib/load-contents.js).
        if (node.excluded === true) { run = null; continue; }
        const id = ++synthChapterId;
        const name = typeof node.name === 'string' ? node.name : '';
        const chapter = { id, name, parent_chapter_id: parentChapterId, slug: slugify(name) };
        const start = groups.length;
        walk(node.children, id, chapter);
        // Eine Gruppe je Kapitel, vor seinen Unterkapiteln (kanonische
        // Lesereihenfolge: eigene Abschnitte zuerst). Abschnitts-Laeufe des
        // Kapitels hinter einem Unterkapitel (aelterer Baum) werden nach vorn
        // gezogen; ohne eigene Abschnitte bleibt eine reine Ueberschriften-
        // Gruppe (`pages: []`), sofern der Teilbaum Text traegt — wie
        // lib/load-contents.js#_groupByChapter.
        if (groups.length > start) {
          const own = [];
          for (let i = groups.length - 1; i >= start; i--) {
            if (groups[i].chapterId === id) own.unshift(...groups.splice(i, 1)[0].pages);
          }
          groups.splice(start, 0, { chapterId: id, chapter, pages: own });
        }
        // Ein Kapitelblock beendet den laufenden Top-/Eltern-Lauf.
        run = null;
      }
    }
  }

  walk(nodes, null, null);

  const name = (typeof content?.book?.name === 'string' && content.book.name) || bookName || '';
  const description = (typeof content?.book?.description === 'string' && content.book.description)
    || bookDescription || '';

  return {
    scope: 'book',
    book: { id: bookId, name, slug: slugify(name), description },
    groups,
  };
}

// Eingefrorene Publikations-Metadaten einer Fassung (book_snapshots.publication_json)
// zurueck in die Live-Form von db/book-publication#getMeta + getCover/getAuthorImage
// aufloesen, damit die Export-Pfade (PDF/EPUB/Sync) sie ohne Sonderfall wie die
// Live-Daten konsumieren koennen. Gespeichert wird:
//   { meta:{…getMeta-Textfelder…}, cover:{b64,mime}|null, authorImage:{b64,mime}|null }
// Liefert null, wenn keine/defekte Publikation eingefroren wurde (Aufrufer faellt
// dann auf die Live-book_publication zurueck). Pure — keine DB, kein Express.
function snapshotPublication(publicationJson) {
  if (!publicationJson) return null;
  let parsed;
  try { parsed = typeof publicationJson === 'string' ? JSON.parse(publicationJson) : publicationJson; }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.meta || typeof parsed.meta !== 'object') return null;

  const cover = parsed.cover && parsed.cover.b64
    ? { image: Buffer.from(parsed.cover.b64, 'base64'), mime: parsed.cover.mime || 'image/jpeg' }
    : null;
  const authorImage = parsed.authorImage && parsed.authorImage.b64
    ? { image: Buffer.from(parsed.authorImage.b64, 'base64'), mime: parsed.authorImage.mime || 'image/jpeg' }
    : null;

  // getMeta-Form: has_cover/has_author_image + Mimes spiegeln die eingefrorenen
  // BLOBs (nicht den Live-Stand), damit die Builder korrekt einbetten.
  const meta = {
    ...parsed.meta,
    has_cover: !!cover,
    cover_mime: cover ? cover.mime : null,
    cover_hash: cover ? imageHash(cover.image) : null,
    has_author_image: !!authorImage,
    author_image_mime: authorImage ? authorImage.mime : null,
    author_image_hash: authorImage ? imageHash(authorImage.image) : null,
  };
  return { meta, cover, authorImage };
}

module.exports = { snapshotToBundle, snapshotPublication, imageHash };

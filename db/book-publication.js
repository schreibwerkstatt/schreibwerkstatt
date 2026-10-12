'use strict';
// CRUD fuer book_publication (1:1 zu books). Buch-weite Publikations-Metadaten
// (Cover/Autorfoto als BLOB + Titelei-Texte + EPUB-Reflow-Toggles). Von PDF-
// und EPUB-Export sowie der Publikation-Karte konsumiert. Sprache bleibt SSoT
// in book_settings.language (hier NICHT gefuehrt).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { defaultMeta, validateMeta } = require('../lib/publication-meta');

const _META_COLS = [
  'author_name', 'author_file_as', 'co_authors', 'extra_sections',
  'isbn', 'subtitle', 'year', 'dedication', 'imprint', 'copyright',
  'frontmatter', 'author_bio', 'epub_css_style', 'epub_justify', 'epub_toc_title',
  'description', 'publisher', 'series', 'series_index', 'keywords',
  'epub_font_size', 'epub_line_height', 'epub_paragraph_style', 'epub_indent_size',
  'epub_hyphenation', 'epub_chapter_pagebreak', 'epub_drop_caps', 'epub_nest_pages_in_toc',
  'epub_scene_separator', 'epub_titlepage_mode',
  'epub_chapter_numbering', 'epub_chapter_numbering_mode', 'epub_unnumbered_chapter_ids',
  'epub_rights', 'epub_pubdate', 'epub_translator', 'epub_illustrator', 'epub_editor_name', 'epub_uuid',
  'epub_imprint_position', 'epub_chapter_title_style', 'epub_heading_font', 'epub_heading_scale',
  'epub_cover_fit', 'epub_numerals', 'epub_toc_depth',
  'epub_subchapter_pagebreak', 'epub_chapter_rule', 'epub_page_rule', 'epub_toc_enabled',
  'epub_chapter_number_divider', 'epub_msg_style',
];

// 0/1-Spalten — beim Upsert aus bool zu Integer wandeln, beim Lesen via
// validateMeta wieder zu bool (validateMeta akzeptiert 0/1/'1'). epub_toc_depth ist
// KEIN Bool (INTEGER-Enum) und bleibt darum hier aussen vor.
const _BOOL_COLS = [
  'epub_justify', 'epub_hyphenation', 'epub_chapter_pagebreak', 'epub_drop_caps', 'epub_nest_pages_in_toc',
  'epub_subchapter_pagebreak', 'epub_chapter_rule', 'epub_page_rule', 'epub_toc_enabled',
  'epub_chapter_number_divider',
];

// JSON-Array-Spalten — beim Upsert aus Array zu JSON-String serialisieren, beim
// Lesen via validateMeta wieder zu Array (validateMeta._idList parst den String).
const _JSON_COLS = ['epub_unnumbered_chapter_ids', 'co_authors', 'extra_sections'];

const _stmtGet = db.prepare(`
  SELECT book_id, ${_META_COLS.join(', ')},
         (cover_image IS NOT NULL) AS has_cover, cover_mime,
         (author_image IS NOT NULL) AS has_author_image, author_image_mime,
         created_at, updated_at
    FROM book_publication WHERE book_id = ?
`);

const _stmtGetCover = db.prepare('SELECT cover_image AS image, cover_mime AS mime FROM book_publication WHERE book_id = ?');
const _stmtGetAuthorImage = db.prepare('SELECT author_image AS image, author_image_mime AS mime FROM book_publication WHERE book_id = ?');

// Upsert nur der Metadaten-Spalten (BLOBs separat). updated_at immer mit.
// Column-Liste aus _META_COLS abgeleitet — kein Hand-Pflege-Drift bei neuen Feldern.
const _stmtUpsertMeta = db.prepare(`
  INSERT INTO book_publication
    (book_id, ${_META_COLS.join(', ')}, created_at, updated_at)
  VALUES
    (@book_id, ${_META_COLS.map(c => `@${c}`).join(', ')}, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(book_id) DO UPDATE SET
    ${_META_COLS.map(c => `${c} = @${c}`).join(', ')},
    updated_at = ${NOW_ISO_SQL}
`);

// BLOB-Setter legen die Zeile bei Bedarf an (Buch koennte noch keine Meta haben).
const _stmtEnsureRow = db.prepare(`
  INSERT INTO book_publication (book_id, created_at, updated_at)
  VALUES (?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(book_id) DO NOTHING
`);
const _stmtSetCover = db.prepare(`UPDATE book_publication SET cover_image = ?, cover_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtClearCover = db.prepare(`UPDATE book_publication SET cover_image = NULL, cover_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtSetAuthorImage = db.prepare(`UPDATE book_publication SET author_image = ?, author_image_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);
const _stmtClearAuthorImage = db.prepare(`UPDATE book_publication SET author_image = NULL, author_image_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`);

// Liefert die validierten Metadaten (Defaults wenn keine Zeile). epub_justify
// als bool, has_cover/has_author_image als Flags fuer die UI.
function getMeta(bookId) {
  const id = parseInt(bookId);
  const row = _stmtGet.get(id);
  if (!row) {
    return { book_id: id, ...defaultMeta(), has_cover: false, has_author_image: false, cover_mime: null, author_image_mime: null };
  }
  return {
    book_id: id,
    ...validateMeta(row),
    has_cover: !!row.has_cover,
    cover_mime: row.cover_mime || null,
    has_author_image: !!row.has_author_image,
    author_image_mime: row.author_image_mime || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function upsertMeta(bookId, meta) {
  const v = validateMeta(meta);
  for (const col of _BOOL_COLS) v[col] = v[col] ? 1 : 0;
  for (const col of _JSON_COLS) v[col] = JSON.stringify(Array.isArray(v[col]) ? v[col] : []);
  _stmtUpsertMeta.run({ book_id: parseInt(bookId), ...v });
  return getMeta(bookId);
}

function setCover(bookId, buffer, mime) {
  _stmtEnsureRow.run(parseInt(bookId));
  _stmtSetCover.run(buffer, mime, parseInt(bookId));
}
function clearCover(bookId) { _stmtClearCover.run(parseInt(bookId)); }
function getCover(bookId) {
  const r = _stmtGetCover.get(parseInt(bookId));
  return r && r.image ? { image: r.image, mime: r.mime } : null;
}

function setAuthorImage(bookId, buffer, mime) {
  _stmtEnsureRow.run(parseInt(bookId));
  _stmtSetAuthorImage.run(buffer, mime, parseInt(bookId));
}
function clearAuthorImage(bookId) { _stmtClearAuthorImage.run(parseInt(bookId)); }
function getAuthorImage(bookId) {
  const r = _stmtGetAuthorImage.get(parseInt(bookId));
  return r && r.image ? { image: r.image, mime: r.mime } : null;
}

module.exports = {
  getMeta, upsertMeta,
  setCover, clearCover, getCover,
  setAuthorImage, clearAuthorImage, getAuthorImage,
};

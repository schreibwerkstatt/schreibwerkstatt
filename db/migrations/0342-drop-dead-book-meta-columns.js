'use strict';
// Tote Kopien von Buch-Metadaten entfernen — sie leben in book_publication:
//   books.description            → book_publication.description (Klappentext)
//   pdf_export_profile.cover_image/cover_mime/author_image/author_image_mime
//                                → book_publication.cover_*/author_image*
// Kein Code liest oder schreibt die Spalten noch; sie standen nur im Schema und
// luden dazu ein, eine zweite Kopie wieder zu beleben. Vor dem Drop wird
// übernommen, was noch drinsteht — nur in ein leeres Ziel, ein gesetzter Wert in
// book_publication gewinnt (wie 0336).

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

module.exports = {
  version: 342,
  up(db) {
    const has = (t, c) => db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);

    if (has('books', 'description')) {
      db.exec(`
        INSERT INTO book_publication (book_id, created_at, updated_at)
        SELECT b.book_id, ${NOW}, ${NOW} FROM books b
         WHERE TRIM(COALESCE(b.description, '')) <> ''
           AND NOT EXISTS (SELECT 1 FROM book_publication bp WHERE bp.book_id = b.book_id);
        UPDATE book_publication
           SET description = SUBSTR((SELECT TRIM(b.description) FROM books b WHERE b.book_id = book_publication.book_id), 1, 4000),
               updated_at  = ${NOW}
         WHERE TRIM(COALESCE(description, '')) = ''
           AND TRIM(COALESCE((SELECT b.description FROM books b WHERE b.book_id = book_publication.book_id), '')) <> '';
        ALTER TABLE books DROP COLUMN description;
      `);
    }

    if (has('pdf_export_profile', 'cover_image')) {
      // Je Buch das Gewinner-Profil (Standard vor zuletzt geändert) mit Bild.
      const pick = (img) => db.prepare(`
        SELECT book_id, ${img} AS image, ${img === 'cover_image' ? 'cover_mime' : 'author_image_mime'} AS mime
          FROM pdf_export_profile
         WHERE book_id IS NOT NULL AND ${img} IS NOT NULL
         ORDER BY book_id, is_default DESC, updated_at DESC`).all();
      const ensureRow = db.prepare(`
        INSERT INTO book_publication (book_id, created_at, updated_at) VALUES (?, ${NOW}, ${NOW})
        ON CONFLICT(book_id) DO NOTHING`);
      const fill = {
        cover_image: db.prepare(`UPDATE book_publication SET cover_image = ?, cover_mime = ?, updated_at = ${NOW}
                                  WHERE book_id = ? AND cover_image IS NULL`),
        author_image: db.prepare(`UPDATE book_publication SET author_image = ?, author_image_mime = ?, updated_at = ${NOW}
                                   WHERE book_id = ? AND author_image IS NULL`),
      };
      for (const img of ['cover_image', 'author_image']) {
        const seen = new Set();
        for (const r of pick(img)) {
          if (seen.has(r.book_id)) continue;
          seen.add(r.book_id);
          ensureRow.run(r.book_id);
          fill[img].run(r.image, r.mime, r.book_id);
        }
      }
      db.exec(`
        ALTER TABLE pdf_export_profile DROP COLUMN cover_image;
        ALTER TABLE pdf_export_profile DROP COLUMN cover_mime;
        ALTER TABLE pdf_export_profile DROP COLUMN author_image;
        ALTER TABLE pdf_export_profile DROP COLUMN author_image_mime;
      `);
    }
  },
};

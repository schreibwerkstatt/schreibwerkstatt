'use strict';
// Klappentext hat EINEN Ort: book_publication.description.
// Vorher lag er dreifach: book_publication.description (Publikation-Tab, EPUB),
// books.description (ohne UI, nur API/Import/Restore, EPUB-Rueckfall) und
// coverSpec.blurb in jedem PDF-Profil (Umschlag-Rueckseite). Nichts glich die
// drei ab. Uebernommen wird jeweils nur in ein leeres Ziel; ein schon gesetzter
// Publikations-Klappentext gewinnt. Danach sind books.description und
// coverSpec.blurb leer — der Content-Store liest/schreibt die Beschreibung ueber
// book_publication, der PDF-Umschlag liest sie aus den Publikationsdaten.

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const BLURB = `json_extract(p.config_json, '$.coverSpec.blurb')`;
const HAS_BLURB = `json_valid(p.config_json) AND TRIM(COALESCE(${BLURB}, '')) <> ''`;

module.exports = {
  version: 336,
  up(db) {
    // Zeile anlegen, wo ein Klappentext uebernommen werden muss.
    db.exec(`
      INSERT INTO book_publication (book_id, created_at, updated_at)
      SELECT b.book_id, ${NOW}, ${NOW} FROM books b
       WHERE NOT EXISTS (SELECT 1 FROM book_publication bp WHERE bp.book_id = b.book_id)
         AND (TRIM(COALESCE(b.description, '')) <> ''
              OR EXISTS (SELECT 1 FROM pdf_export_profile p WHERE p.book_id = b.book_id AND ${HAS_BLURB}));
    `);

    // 1. books.description (Altbestand ohne UI).
    db.exec(`
      UPDATE book_publication
         SET description = SUBSTR((SELECT TRIM(b.description) FROM books b WHERE b.book_id = book_publication.book_id), 1, 4000),
             updated_at = ${NOW}
       WHERE TRIM(COALESCE(description, '')) = ''
         AND EXISTS (SELECT 1 FROM books b WHERE b.book_id = book_publication.book_id
                       AND TRIM(COALESCE(b.description, '')) <> '');
    `);

    // 2. coverSpec.blurb: Standardprofil des Buchs vor dem zuletzt geaenderten.
    db.exec(`
      UPDATE book_publication
         SET description = SUBSTR((SELECT TRIM(${BLURB}) FROM pdf_export_profile p
                                    WHERE p.book_id = book_publication.book_id AND ${HAS_BLURB}
                                    ORDER BY p.is_default DESC, p.updated_at DESC, p.id DESC
                                    LIMIT 1), 1, 4000),
             updated_at = ${NOW}
       WHERE TRIM(COALESCE(description, '')) = ''
         AND EXISTS (SELECT 1 FROM pdf_export_profile p WHERE p.book_id = book_publication.book_id AND ${HAS_BLURB});
    `);

    db.exec(`
      UPDATE pdf_export_profile
         SET config_json = json_remove(config_json, '$.coverSpec.blurb')
       WHERE json_valid(config_json) AND json_type(config_json, '$.coverSpec.blurb') IS NOT NULL;
      UPDATE books SET description = NULL WHERE description IS NOT NULL;
    `);
  },
};

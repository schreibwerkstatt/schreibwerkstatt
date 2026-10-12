'use strict';
// EPUB: Gestaltung der Kapitel- und Abschnittsueberschriften — Linie/Ornament
// (Art, Staerke, Breite, Lage), Kapitelnummer (Praefix, Schreibung, Sperrung,
// Groesse) und Ausrichtung/Linie der Unterkapitel und Abschnittstitel.
// Pendant zu `config.chapter.*` der PDF-Profile; Werte und Defaults sind SSoT in
// lib/heading-style.js. Der Trenner Nummer↔Titel liegt schon in
// epub_chapter_number_divider.

const COLS = [
  ['epub_rule_style', "TEXT DEFAULT 'single'"],
  ['epub_rule_weight', "TEXT DEFAULT 'thin'"],
  ['epub_rule_width', "TEXT DEFAULT 'auto'"],
  ['epub_rule_position', "TEXT DEFAULT 'below'"],
  ['epub_number_prefix', "TEXT DEFAULT 'none'"],
  ['epub_number_prefix_text', "TEXT DEFAULT ''"],
  ['epub_number_case', "TEXT DEFAULT 'normal'"],
  ['epub_number_tracking', 'INTEGER DEFAULT 1'],
  ['epub_number_size_pct', 'INTEGER DEFAULT 62'],
  ['epub_sub_title_align', "TEXT DEFAULT 'left'"],
  ['epub_sub_title_rule', 'INTEGER DEFAULT 0'],
  ['epub_page_title_align', "TEXT DEFAULT 'left'"],
];

module.exports = {
  version: 327,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(book_publication)').all().map(c => c.name);
    for (const [name, def] of COLS) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${name} ${def}`);
    }
  },
};

'use strict';
// Schullaufbahn der Figuren (docs/figur-lebenslauf.md, «Schullaufbahn»).
//
// book_settings.schulsystem_json: Schulsystem des Buchs (Vorlage, Einschulungsalter,
//   Stichtag, Schuljahresbeginn, Jahre je Stufe, Standardweg). Normalisiert ueber
//   public/js/book/school-path.js#normalizeSchulsystem. NULL = kein Schulsystem.
//
// figure_school_paths: Schulweg je Figur, eine Zeile pro Figur (figures.id).
//   weg / einschulung_jahr / repetitionen_json gehoeren dem Autor (source 'autor')
//   oder stammen aus einem uebernommenen KI-Vorschlag (source 'ki'); NULL = noch
//   nichts gesetzt. vorschlag_json traegt einen offenen KI-Vorschlag samt Beleg,
//   bis der Autor ihn uebernimmt oder verwirft — der Job schreibt NUR diese Spalte.
//   CASCADE: die Figuren-Zeile bleibt ueber Komplettanalysen stabil (Reconcile
//   matcht in place); faellt die Figur, faellt ihr Schulweg mit.
module.exports = {
  version: 345,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(book_settings)').all().map(c => c.name));
    if (!cols.has('schulsystem_json')) db.exec('ALTER TABLE book_settings ADD COLUMN schulsystem_json TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_school_paths (
        figure_id         INTEGER PRIMARY KEY REFERENCES figures(id) ON DELETE CASCADE,
        weg               TEXT,
        einschulung_jahr  INTEGER,
        repetitionen_json TEXT,
        source            TEXT CHECK(source IS NULL OR source IN ('autor','ki')),
        vorschlag_json    TEXT,
        updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
  },
};

'use strict';
// Figuren-Identitaet ueber Komplettanalyse-Laeufe (docs/komplett.md, Phase 2):
//
// figure_aliases: Namen, unter denen eine Katalogfigur im Text ebenfalls steht —
//   vom Autor bestaetigt, entstanden beim manuellen Zusammenfuehren (Name/Kurzname
//   der weggemergten Quelle). Der Cross-Run-Abgleich (planFigurenMatch) und die
//   Namens-Aufloesung der Szenen/Ereignisse (buildFigNameLookup) lesen sie, damit
//   eine zusammengefuehrte Figur beim naechsten Lauf nicht als eigener Eintrag
//   wiederkehrt. Gespeichert wird die Anzeigeform; normalisiert wird beim Lesen
//   (lib/name-normalize.js#normName) — eine gespeicherte Normalform muesste bei
//   jeder Aenderung der Normalisierung migriert werden. CASCADE mit der Figur und
//   dem Buch: ohne ihre Figur ist eine Alias-Zeile bedeutungslos.
//
// figures.ki_geschlecht / figures.ki_geburtstag: der Wert, den die Analyse zuletzt
//   geliefert hat (Muster figures.ki_name). Der Indizien-Vergleich (figureEvidence)
//   misst eine vom Autor gepflegte Figur (manually_edited = 1) gegen diese Werte,
//   nicht gegen die Korrektur — sonst laese er die eigene Korrektur als Widerspruch
//   zur Analyse und machte die Figur beim naechsten Lauf zur Dublette. Backfill nur
//   fuer ungepflegte Figuren (dort ist der Katalogwert der Analysewert); bei
//   gepflegten ist der letzte Analysewert unbekannt und bleibt NULL (kein Indiz).
module.exports = {
  version: 321,
  up(db) {
    const figCols = new Set(db.prepare('PRAGMA table_info(figures)').all().map(c => c.name));
    if (!figCols.has('ki_geschlecht')) db.exec('ALTER TABLE figures ADD COLUMN ki_geschlecht TEXT');
    if (!figCols.has('ki_geburtstag')) db.exec('ALTER TABLE figures ADD COLUMN ki_geburtstag TEXT');
    db.exec(`UPDATE figures SET ki_geschlecht = geschlecht, ki_geburtstag = geburtstag
              WHERE manually_edited = 0`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_aliases (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id  INTEGER NOT NULL REFERENCES figures(id)      ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id)   ON DELETE CASCADE,
        alias      TEXT    NOT NULL CHECK(length(trim(alias)) > 0),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(figure_id, alias)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_figure_aliases_book ON figure_aliases(book_id)');
  },
};

'use strict';
// Vom Autor gepflegte Figuren und Beziehungen gegen die Komplettanalyse schuetzen
// (Gegenstueck zu locations.manually_edited/ki_name, docs/komplett.md).
//
// figures.manually_edited: 1, sobald der Autor die Stammdaten einer Figur ueber den
//   Katalog-PUT aendert oder die Figur dort anlegt. Die Analyse ueberschreibt dann
//   die kuratierten Felder nicht mehr, liefert aber weiter die abgeleiteten.
// figures.ki_name: der Name, den die Analyse zuletzt geliefert hat. Der Cross-Run-
//   Abgleich matcht darueber, damit eine vom Autor umbenannte Figur beim naechsten
//   Lauf nicht als «nicht mehr im Text» endet. Backfill mit dem aktuellen Namen —
//   vor dieser Migration gab es keine manuelle Pflege, die geschuetzt war.
// figure_relations.origin: 'ki' (Analyse, wird pro Lauf neu aufgebaut) oder
//   'manual' (vom Autor angelegt/geaendert, ueberlebt jeden Lauf).
module.exports = {
  version: 313,
  up(db) {
    const figCols = new Set(db.prepare('PRAGMA table_info(figures)').all().map(c => c.name));
    if (!figCols.has('manually_edited')) {
      db.exec('ALTER TABLE figures ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0 CHECK(manually_edited IN (0,1))');
    }
    if (!figCols.has('ki_name')) {
      db.exec('ALTER TABLE figures ADD COLUMN ki_name TEXT');
      db.exec('UPDATE figures SET ki_name = name WHERE ki_name IS NULL');
    }
    const relCols = new Set(db.prepare('PRAGMA table_info(figure_relations)').all().map(c => c.name));
    if (!relCols.has('origin')) {
      db.exec("ALTER TABLE figure_relations ADD COLUMN origin TEXT NOT NULL DEFAULT 'ki' CHECK(origin IN ('ki','manual'))");
    }
  },
};

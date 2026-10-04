'use strict';
// Buchsprache der Wortschatz-Analyse (docs/wortschatz.md, „Sprache").
//
// Die Spalte hält die Sprache, mit der DIESER Scan gerechnet hat — nicht die
// aktuelle Buch-Einstellung. Referenzkorpus und Vergleichs-Mediane vergleichen nur
// Bücher derselben Sprache, und dafür zählt, womit die gespeicherte Frequenztabelle
// gezählt wurde: ein Buch, dessen Einstellung gerade umgestellt wurde, trägt bis
// zum nächsten Scan noch die alte Tabelle. NULL = Scan vor dieser Migration; solche
// Zeilen haben ohnehin eine ältere `lexicon_version` und zählen nirgends mit.
module.exports = {
  version: 317,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(book_lexicon)').all().map(c => c.name);
    if (!cols.includes('language')) {
      db.exec("ALTER TABLE book_lexicon ADD COLUMN language TEXT CHECK (language IS NULL OR language IN ('de','en'))");
    }
  },
};

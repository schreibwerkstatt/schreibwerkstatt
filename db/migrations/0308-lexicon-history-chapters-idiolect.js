'use strict';
// Wortschatz-Analyse, Ausbau (docs/wortschatz.md).
//
// - `book_lexicon.input_sig`   Signatur ALLER Eingänge des Scans: Text (content_sig),
//                              Namensliste und die Textstände der Referenzbücher.
//                              `content_sig` bleibt die reine Text-Signatur — genau
//                              die geht in die input_sig der ANDEREN Bücher ein.
//                              Hinge sie selbst an den Referenzen, schaukelten sich
//                              zwei Bücher desselben Autors Nacht für Nacht
//                              gegenseitig neu an.
// - `book_lexicon.idiolect_coverage`  Anteil der wörtlichen Rede, der einer Figur
//                              zugeordnet werden konnte — ohne ihn liest sich der
//                              Idiolekt-Ausschnitt als Vollständigkeit.
// - `lexicon_terms.novel`      Einmalwort kommt in den übrigen Büchern des Autors
//                              nicht vor (erstes Auswahlkriterium der Liste).
// - `lexicon_terms.sort_rank`  Rang in der Auswahl — die Karte zeigt dieselbe
//                              Reihenfolge, nach der ausgewählt wurde.
// - `book_stats_history.*`     Tagesverlauf der längenrobusten Kennzahlen; ohne ihn
//                              gibt es nur den letzten Scan, keinen Trend.
// - `chapter_lexicon`          dieselben Masse pro Kapitel + Burrows's Delta gegen
//                              den Buchschnitt. Abgeleitet, Full-Replace pro Scan.
// - `figure_idiolect`          Wortschatz der wörtlichen Rede je Figur. Abgeleitet,
//                              Full-Replace pro Scan.
module.exports = {
  version: 308,
  up(db) {
    db.exec(`ALTER TABLE book_lexicon ADD COLUMN input_sig TEXT`);
    db.exec(`ALTER TABLE book_lexicon ADD COLUMN idiolect_coverage REAL`);
    db.exec(`ALTER TABLE lexicon_terms ADD COLUMN novel INTEGER CHECK (novel IS NULL OR novel IN (0, 1))`);
    db.exec(`ALTER TABLE lexicon_terms ADD COLUMN sort_rank INTEGER`);

    db.exec(`ALTER TABLE book_stats_history ADD COLUMN mattr REAL`);
    db.exec(`ALTER TABLE book_stats_history ADD COLUMN mtld REAL`);
    db.exec(`ALTER TABLE book_stats_history ADD COLUMN lex_density REAL`);
    db.exec(`ALTER TABLE book_stats_history ADD COLUMN hapax_ratio REAL`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_lexicon (
        chapter_id    INTEGER PRIMARY KEY REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        tokens        INTEGER NOT NULL CHECK (tokens >= 0),
        types         INTEGER NOT NULL CHECK (types >= 0),
        hapax_ratio   REAL,
        mattr         REAL,
        mattr_window  INTEGER CHECK (mattr_window IS NULL OR mattr_window >= 0),
        mtld          REAL,
        yule_k        REAL,
        lex_density   REAL,
        delta         REAL,
        delta_top_json TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chapter_lexicon_book ON chapter_lexicon(book_id)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_idiolect (
        figure_id     INTEGER PRIMARY KEY REFERENCES figures(id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        utterances    INTEGER NOT NULL CHECK (utterances >= 0),
        tokens        INTEGER NOT NULL CHECK (tokens >= 0),
        types         INTEGER NOT NULL CHECK (types >= 0),
        mattr         REAL,
        mattr_window  INTEGER CHECK (mattr_window IS NULL OR mattr_window >= 0),
        mtld          REAL,
        avg_utterance_len REAL,
        terms_json    TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_figure_idiolect_book ON figure_idiolect(book_id)`);
  },
};

'use strict';
// Ideen duerfen zusaetzlich an einer WERKSTATT-FIGUR (`draft_figures`) und an
// einem HANDLUNGSSTRANG (`plot_threads`) haengen (docs/ideen-board.md,
// „Verknuepfungen").
//
// Beide sind — wie Fundstueck, Beat und Motiv — PLANENDE Kataloge desselben
// Buches: eine Pendenz wie „Bogen von Anna klaeren" oder „B-Story braucht einen
// Wendepunkt" hatte bisher nur eine Seite oder ein Kapitel als Ort, obwohl sie
// an der Figur bzw. am Strang haengt.
//
// Sentinel-frei wie bisher: je Ziel-Art eine eigene nullbare FK-Spalte, der CHECK
// verlangt genau die zur Art passende. ON DELETE CASCADE wie bei den drei
// bestehenden Zielen — eine Kante ohne Gegenseite ist bedeutungslos, die Idee
// selbst bleibt stehen.
//
// Recreate, weil SQLite einen Tabellen-CHECK nicht per ALTER aendern kann.
module.exports = {
  version: 318,
  fkOff: true,
  up(db) {
    db.exec('DROP TABLE IF EXISTS idea_links_new');
    db.exec(`
      CREATE TABLE idea_links_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id         INTEGER NOT NULL REFERENCES ideen(id)           ON DELETE CASCADE,
        target_kind     TEXT    NOT NULL CHECK(target_kind IN ('research','beat','motif','draft','thread')),
        research_id     INTEGER          REFERENCES research_items(id)  ON DELETE CASCADE,
        beat_id         INTEGER          REFERENCES plot_beats(id)      ON DELETE CASCADE,
        motif_id        INTEGER          REFERENCES motifs(id)          ON DELETE CASCADE,
        draft_figure_id INTEGER          REFERENCES draft_figures(id)   ON DELETE CASCADE,
        thread_id       INTEGER          REFERENCES plot_threads(id)    ON DELETE CASCADE,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (target_kind='research' AND research_id     IS NOT NULL AND beat_id IS NULL AND motif_id IS NULL AND draft_figure_id IS NULL AND thread_id IS NULL) OR
          (target_kind='beat'     AND beat_id         IS NOT NULL AND research_id IS NULL AND motif_id IS NULL AND draft_figure_id IS NULL AND thread_id IS NULL) OR
          (target_kind='motif'    AND motif_id        IS NOT NULL AND research_id IS NULL AND beat_id IS NULL AND draft_figure_id IS NULL AND thread_id IS NULL) OR
          (target_kind='draft'    AND draft_figure_id IS NOT NULL AND research_id IS NULL AND beat_id IS NULL AND motif_id IS NULL AND thread_id IS NULL) OR
          (target_kind='thread'   AND thread_id       IS NOT NULL AND research_id IS NULL AND beat_id IS NULL AND motif_id IS NULL AND draft_figure_id IS NULL)
        )
      )
    `);
    db.exec(`
      INSERT INTO idea_links_new (id, idea_id, target_kind, research_id, beat_id, motif_id, created_at)
      SELECT id, idea_id, target_kind, research_id, beat_id, motif_id, created_at
        FROM idea_links
    `);
    db.exec('DROP TABLE idea_links');
    db.exec('ALTER TABLE idea_links_new RENAME TO idea_links');
    db.exec('CREATE INDEX idx_idea_links_idea     ON idea_links(idea_id)');
    db.exec('CREATE INDEX idx_idea_links_research ON idea_links(research_id)');
    db.exec('CREATE INDEX idx_idea_links_beat     ON idea_links(beat_id)');
    db.exec('CREATE INDEX idx_idea_links_motif    ON idea_links(motif_id)');
    db.exec('CREATE INDEX idx_idea_links_draft    ON idea_links(draft_figure_id)');
    db.exec('CREATE INDEX idx_idea_links_thread   ON idea_links(thread_id)');
    db.exec('CREATE UNIQUE INDEX idx_idea_links_uniq_research ON idea_links(idea_id, research_id)     WHERE research_id     IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX idx_idea_links_uniq_beat     ON idea_links(idea_id, beat_id)         WHERE beat_id         IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX idx_idea_links_uniq_motif    ON idea_links(idea_id, motif_id)        WHERE motif_id        IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX idx_idea_links_uniq_draft    ON idea_links(idea_id, draft_figure_id) WHERE draft_figure_id IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX idx_idea_links_uniq_thread   ON idea_links(idea_id, thread_id)       WHERE thread_id       IS NOT NULL');
  },
};

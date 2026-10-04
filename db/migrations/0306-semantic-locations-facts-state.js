'use strict';
// Semantische Suche (docs/semantic-search.md):
//
// 1. `semantic_chunks` bekommt zwei weitere Quell-Kinds — `location` (Schauplatz,
//    FK locations) und `fact` (Weltfakt, FK world_facts), beide ON DELETE CASCADE
//    wie die übrigen: der Index ist reine Ableitung. CHECK auf `kind` und die
//    generierte `entity_id` hängen an der Spaltenliste → Recreate mit
//    Datenübernahme (die Vektoren bleiben, kein Reindex nötig).
//
// 2. `semantic_index_state` hält pro (Buch, Modell) den Zeitpunkt des letzten
//    VOLLSTÄNDIG durchgelaufenen Index-Laufs. Ein abgebrochener Lauf schreibt hier
//    nichts — Konsumenten, die „kein Treffer" als „kommt nicht vor" werten
//    (Motiv-Scan, Beat-/Figuren-Anker), fragen diesen Stand statt der blossen
//    Chunk-Existenz ab. CASCADE: Ableitungs-Zustand, stirbt mit dem Buch.
module.exports = {
  version: 306,
  fkOff: true,
  up(db) {
    db.exec('DROP TABLE IF EXISTS semantic_chunks_new');
    db.exec(`
      CREATE TABLE semantic_chunks_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT    NOT NULL CHECK(kind IN ('page','scene','figure','research','location','fact')),
        book_id       INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_id       INTEGER REFERENCES pages(page_id)                ON DELETE CASCADE,
        scene_id      INTEGER REFERENCES figure_scenes(id)             ON DELETE CASCADE,
        figure_id     INTEGER REFERENCES figures(id)                   ON DELETE CASCADE,
        research_item_id INTEGER REFERENCES research_items(id)         ON DELETE CASCADE,
        location_id   INTEGER REFERENCES locations(id)                 ON DELETE CASCADE,
        world_fact_id INTEGER REFERENCES world_facts(id)               ON DELETE CASCADE,
        entity_id     INTEGER GENERATED ALWAYS AS (COALESCE(page_id, scene_id, figure_id, research_item_id, location_id, world_fact_id)) VIRTUAL,
        chunk_ix      INTEGER NOT NULL DEFAULT 0,
        content_hash  TEXT    NOT NULL,
        model         TEXT    NOT NULL,
        dim           INTEGER NOT NULL,
        vector        BLOB    NOT NULL,
        text          TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (CASE WHEN page_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN scene_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN figure_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN research_item_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN location_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN world_fact_id IS NOT NULL THEN 1 ELSE 0 END) = 1
          AND (
            (kind = 'page'     AND page_id          IS NOT NULL) OR
            (kind = 'scene'    AND scene_id         IS NOT NULL) OR
            (kind = 'figure'   AND figure_id        IS NOT NULL) OR
            (kind = 'research' AND research_item_id IS NOT NULL) OR
            (kind = 'location' AND location_id      IS NOT NULL) OR
            (kind = 'fact'     AND world_fact_id    IS NOT NULL)
          )
        )
      )
    `);
    db.exec(`
      INSERT INTO semantic_chunks_new
        (id, kind, book_id, page_id, scene_id, figure_id, research_item_id,
         chunk_ix, content_hash, model, dim, vector, text, created_at)
      SELECT id, kind, book_id, page_id, scene_id, figure_id, research_item_id,
             chunk_ix, content_hash, model, dim, vector, text, created_at
        FROM semantic_chunks
    `);
    db.exec('DROP TABLE semantic_chunks');
    db.exec('ALTER TABLE semantic_chunks_new RENAME TO semantic_chunks');
    db.exec('CREATE UNIQUE INDEX idx_semchunk_uniq ON semantic_chunks(kind, entity_id, chunk_ix, model)');
    db.exec('CREATE INDEX idx_semchunk_book ON semantic_chunks(book_id, kind)');
    db.exec('CREATE INDEX idx_semchunk_page ON semantic_chunks(page_id)');
    db.exec('CREATE INDEX idx_semchunk_scene ON semantic_chunks(scene_id)');
    db.exec('CREATE INDEX idx_semchunk_figure ON semantic_chunks(figure_id)');
    db.exec('CREATE INDEX idx_semchunk_research ON semantic_chunks(research_item_id)');
    db.exec('CREATE INDEX idx_semchunk_location ON semantic_chunks(location_id)');
    db.exec('CREATE INDEX idx_semchunk_fact ON semantic_chunks(world_fact_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_index_state (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        model       TEXT    NOT NULL,
        indexed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, model)
      )
    `);
    // Bestand: wer schon Chunks hat, galt bisher als indiziert — der jüngste Chunk
    // war der Lauf-Zeitpunkt. Ohne diese Übernahme meldeten alle Bücher bis zum
    // nächsten Nacht-Lauf „kein Index" und die Anker-Läufe setzten aus.
    db.exec(`
      INSERT OR IGNORE INTO semantic_index_state (book_id, model, indexed_at)
      SELECT book_id, model, MAX(created_at) FROM semantic_chunks GROUP BY book_id, model
    `);
  },
};

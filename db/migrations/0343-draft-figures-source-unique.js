'use strict';
// Eine Katalog-Figur haengt an hoechstens EINEM Werkstatt-Draft desselben Users.
// Import (409 ALREADY_IMPORTED), nachtraegliche Verknuepfung und der Figuren-
// Merge (db/entity-merge.js) ziehen die Regel im Code; der partielle UNIQUE-Index
// macht sie zur Schema-Invariante, damit ein kuenftiger Schreibweg sie nicht
// still umgeht. Zwei Drafts auf derselben Quelle machten die Lesezeit-
// Aufloesung (Plot-/Motiv-Bruecken, Quell-Figur-Ausschluss) mehrdeutig.
//
// Vorhandene Dubletten: der aelteste Draft behaelt den Zeiger, die uebrigen
// verlieren ihn (der Draft selbst bleibt — `source_figure_id` ist ein Zeiger,
// kein Besitz; gleiche Aufloesung wie `draftsUnlinked` im Merge).

module.exports = {
  version: 343,
  up(db) {
    db.exec(`
      UPDATE draft_figures
         SET source_figure_id = NULL
       WHERE source_figure_id IS NOT NULL
         AND id <> (SELECT MIN(d2.id) FROM draft_figures d2
                     WHERE d2.user_email = draft_figures.user_email
                       AND d2.source_figure_id = draft_figures.source_figure_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_df_user_source_unique
        ON draft_figures(user_email, source_figure_id)
        WHERE source_figure_id IS NOT NULL;
    `);
  },
};

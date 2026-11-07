'use strict';
// Löschmarken für KI-Beziehungen (docs/graph.md, «Korrekturen des Autors»).
//
// Löscht oder hängt der Autor eine Beziehung um, die die Komplettanalyse angelegt
// hat (`figure_relations.origin = 'ki'`), merkt sich das Buch die verworfene Kante
// hier. Der nächste Analyselauf (db/figures/save.js#_writeRelations) legt sie dann
// nicht wieder an. Ohne Marke käme dieselbe falsche Kante bei jedem Lauf zurück.
//
// Kanonische Form wie `relationKey` (db/figures/refs.js): kleinere figures.id in
// `from_fig_id`, ein gerichteter Typ beim Tauschen auf sein Inverses — so trifft
// die Marke beide Perspektiven derselben Aussage, und UNIQUE verhindert Dubletten.
//
// CASCADE an den Figuren: die figures.id bleibt über Analyseläufe stabil
// (Reconcile matcht in place); fällt die Figur, ist die Marke gegenstandslos.
module.exports = {
  version: 358,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_relation_suppressions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        from_fig_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        to_fig_id   INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        typ         TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(book_id, user_email, from_fig_id, to_fig_id, typ)
      );
      CREATE INDEX IF NOT EXISTS idx_frel_supp_book ON figure_relation_suppressions(book_id);
      CREATE INDEX IF NOT EXISTS idx_frel_supp_user ON figure_relation_suppressions(user_email);
      CREATE INDEX IF NOT EXISTS idx_frel_supp_from ON figure_relation_suppressions(from_fig_id);
      CREATE INDEX IF NOT EXISTS idx_frel_supp_to   ON figure_relation_suppressions(to_fig_id);
    `);
  },
};

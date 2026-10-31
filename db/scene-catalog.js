'use strict';
// Szenen-Katalog: Lesepfad (GET /figures/scenes/:book_id) mit Szenen eines
// Buchs/Users mit Kapitel-/Seitennamen und ihren Figuren-/Orts-Brücken. Der
// Namens-JOIN auf chapters/pages liegt hier und nicht im Route-Handler
// (CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt", Muster
// db/sources/citations.js#listSourceCitations).

const { db } = require('./connection');
require('./migrations');
const { inClause } = require('../lib/validate');

function listScenesWithRefs(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT fs.id, c.chapter_name AS kapitel, p.page_name AS seite,
           fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id, fs.stale, fs.updated_at
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order
  `).all(bookId, userEmail || null);
  if (!rows.length) return { rows, sfRows: [], slRows: [] };
  const { sql, values } = inClause(rows.map(r => r.id));
  const sfRows = db.prepare(`
    SELECT sf.scene_id, f.fig_id
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.scene_id IN ${sql}
  `).all(...values);
  const slRows = db.prepare(`
    SELECT sl.scene_id, l.loc_id
    FROM scene_locations sl
    JOIN locations l ON sl.location_id = l.id
    WHERE sl.scene_id IN ${sql}
  `).all(...values);
  return { rows, sfRows, slRows };
}

/** Bulk-Cleanup (Danger-Zone, DELETE /figures/scenes/:book_id/stale): alle STALE
 *  Szenen eines Buchs/Users loeschen. CASCADE raeumt die Bridges mit. Gibt die
 *  geloeschten IDs zurueck (Suchindex). Muster db/locations-edit.js#deleteStaleLocations. */
function deleteStaleScenes(bookId, userEmail) {
  const ids = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ? AND user_email IS ? AND stale = 1')
    .all(bookId, userEmail || null).map(r => r.id);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM figure_scenes WHERE id = ?');
    for (const id of ids) del.run(id);
  })();
  return ids;
}

module.exports = { listScenesWithRefs, deleteStaleScenes };

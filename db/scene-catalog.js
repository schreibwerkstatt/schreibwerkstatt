'use strict';
// Lesepfad des Szenen-Katalogs (GET /figures/scenes/:book_id): Szenen eines
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

module.exports = { listScenesWithRefs };

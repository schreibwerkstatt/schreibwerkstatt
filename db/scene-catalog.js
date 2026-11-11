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
           fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id, fs.stale, fs.updated_at,
           p.updated_at AS page_updated_at
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

/** Jüngstes Lektorat mit Szenen-Bewertung je Abschnitt (Map page_id →
 *  { checked_at, szenen }), nur für die übergebenen Abschnitte und nur des
 *  Users, dem auch der Szenen-Katalog gehört. Läufe ohne Szenen (lokaler
 *  Provider, leerer Abschnitt) zählen nicht — sonst verdeckte ein solcher Lauf
 *  die letzte echte Bewertung. Lesezeit-Verknüpfung, der Katalog bleibt
 *  unberührt. Die page_ids stammen aus dem Buch-Katalog, darum filtert die
 *  Abfrage nicht nach book_id (historische page_checks tragen sie nicht immer).
 *  Doku: docs/lektorat.md#das-feld-szenen. */
function latestLektoratSzenenByPage(userEmail, pageIds) {
  const out = new Map();
  if (!userEmail || !pageIds.length) return out;
  const { sql, values } = inClause(pageIds);
  const rows = db.prepare(`
    SELECT page_id, checked_at, szenen_json FROM (
      SELECT page_id, checked_at, szenen_json,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC, id DESC) AS rn
      FROM page_checks
      WHERE user_email = ? AND page_id IN ${sql}
        AND szenen_json IS NOT NULL AND szenen_json NOT IN ('', '[]')
    ) WHERE rn = 1
  `).all(userEmail, ...values);
  for (const r of rows) {
    let szenen;
    try { szenen = JSON.parse(r.szenen_json); } catch { continue; }
    if (!Array.isArray(szenen)) continue;
    szenen = szenen
      .filter(x => x && typeof x.titel === 'string')
      .map(x => ({ titel: x.titel, wertung: x.wertung || null, kommentar: x.kommentar || null }));
    if (szenen.length) out.set(r.page_id, { checked_at: r.checked_at, szenen });
  }
  return out;
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

/** Szenen eines Buchs als Antwort von GET /figures/scenes/:book_id: Zeile +
 *  Figuren-/Orts-IDs, dazu der jüngste Stand über alle Szenen (wie der
 *  Figuren-Katalog), nicht der der ersten nach sort_order. */
function listScenesForBook(bookId, userEmail) {
  const { rows, sfRows, slRows } = listScenesWithRefs(bookId, userEmail);
  const sfMap = {};
  for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);
  const slMap = {};
  for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);
  const pageIds = [...new Set(rows.map(r => r.page_id).filter(id => id != null))];
  const lektorat = latestLektoratSzenenByPage(userEmail, pageIds);
  const szenen = rows.map(s => ({
    id:         s.id,
    stale:      !!s.stale,
    kapitel:    s.kapitel,
    seite:      s.seite,
    titel:      s.titel,
    wertung:    s.wertung,
    kommentar:  s.kommentar,
    chapter_id: s.chapter_id,
    page_id:    s.page_id,
    fig_ids:    sfMap[s.id] || [],
    ort_ids:    slMap[s.id] || [],
    // Abschnitt seit dem letzten Analyselauf, der diese Szene erkannt hat, bearbeitet.
    text_geaendert: !!(s.page_updated_at && s.updated_at && s.page_updated_at > s.updated_at),
    lektorat:   (s.page_id != null && lektorat.get(s.page_id)) || null,
  }));
  const updated_at = rows.reduce((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);
  return { szenen, updated_at };
}

module.exports = { listScenesForBook, deleteStaleScenes, latestLektoratSzenenByPage };

'use strict';
// Schauplatz-Katalog eines Buchs fuer die Karte (GET /locations/:book_id). Eigenes
// Modul, weil die Kapitelnamen per JOIN auf `chapters` kommen — ein solcher Join
// gehoert nicht in den Route-Handler (CLAUDE.md „Content-Store-Facade").
//
// Ausgeliefert wird die oeffentliche Kennung `loc_id` als `id`; die INTEGER-PK
// verlaesst das Modul nie. `parent` ist entsprechend die loc_id des Elternorts.

const { db } = require('./connection');
require('./migrations');
const { inClause } = require('../lib/validate');
const { pageChapters } = require('./content-names');

function listLocationsForBook(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.erste_erwaehnung, l.erste_erwaehnung_page_id,
           l.stimmung, l.land, l.lat, l.lng, l.geo_query, l.geo_land, l.stale, l.updated_at,
           l.manually_edited, l.manually_created, p.loc_id AS parent_loc_id
    FROM locations l
    LEFT JOIN locations p ON p.id = l.parent_id
    WHERE l.book_id = ? AND l.user_email IS ?
    ORDER BY l.sort_order, l.id
  `).all(bookId, userEmail || null);
  if (!rows.length) return null;

  const { sql, values } = inClause(rows.map(r => r.id));
  const figMap = {};
  for (const lf of db.prepare(`
    SELECT lf.location_id, f.fig_id
    FROM location_figures lf JOIN figures f ON f.id = lf.figure_id
    WHERE lf.location_id IN ${sql}
  `).all(...values)) (figMap[lf.location_id] ??= []).push(lf.fig_id);

  const kapMap = {};
  for (const lc of db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${sql}
    ORDER BY lc.haeufigkeit DESC
  `).all(...values)) {
    (kapMap[lc.location_id] ??= []).push({ chapter_id: lc.chapter_id, name: lc.chapter_name, haeufigkeit: lc.haeufigkeit });
  }

  // Fallback-Kapitel: ohne location_chapters, aber mit Erste-Erwähnung-Seite leitet
  // sich das Kapitel aus deren chapter_id ab.
  const derivePageIds = [...new Set(
    rows.filter(r => !kapMap[r.id] && r.erste_erwaehnung_page_id).map(r => r.erste_erwaehnung_page_id),
  )];
  const pageChapterMap = {};
  if (derivePageIds.length) {
    for (const [pageId, pc] of pageChapters(derivePageIds)) {
      pageChapterMap[pageId] = { chapter_id: pc.chapter_id, name: pc.chapter_name, haeufigkeit: 1, derived: true };
    }
  }

  const orte = rows.map(r => ({
    id:                       r.loc_id,
    stale:                    !!r.stale,
    name:                     r.name,
    typ:                      r.typ,
    beschreibung:             r.beschreibung,
    erste_erwaehnung:         r.erste_erwaehnung,
    erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
    stimmung:                 r.stimmung,
    land:                     r.land || null,
    lat:                      r.lat != null ? r.lat : null,
    lng:                      r.lng != null ? r.lng : null,
    geo_query:                r.geo_query || null,
    geo_land:                 r.geo_land || null,
    parent:                   r.parent_loc_id || null,
    manually_edited:          !!r.manually_edited,
    manually_created:         !!r.manually_created,
    figuren:                  figMap[r.id] || [],
    kapitel:                  kapMap[r.id] || (pageChapterMap[r.erste_erwaehnung_page_id] ? [pageChapterMap[r.erste_erwaehnung_page_id]] : []),
  }));
  // Jüngster Stand über alle Orte (ein manueller Edit stempelt nur seine Zeile).
  const updated_at = rows.reduce((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);
  return { orte, updated_at };
}

// Ortsname per locations.id fuer Treffer des Embedding-Index (Kind `location`).
// Ohne `opts.userEmail`-Schluessel ungescoped; mit Schluessel nur, wenn der Ort dem
// User gehoert (Analyse-Daten sind user-scoped, der Index haengt nur am Buch).
// undefined = Ort fehlt bzw. gehoert einem anderen User.
const _stmtLocName = db.prepare('SELECT name AS t FROM locations WHERE id = ?');
const _stmtLocNameForUser = db.prepare('SELECT name AS t FROM locations WHERE id = ? AND user_email IS ?');
function getLocationName(locationId, opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'userEmail')) {
    return _stmtLocNameForUser.get(locationId, opts.userEmail ?? null)?.t;
  }
  return _stmtLocName.get(locationId)?.t;
}

module.exports = { listLocationsForBook, getLocationName };

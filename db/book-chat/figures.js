'use strict';
// Abfragen der figurenfokussierten Buch-Chat-Tools
// (routes/jobs/book-chat-tools/tools-figures.js) plus der geteilten
// Figuren-Lookups (`_findFigure`, `resolveEntityTitle` in shared.js, Namens-Map
// von get_plot_board). Die Tool-Module führen selbst kein SQL aus; Seiten-/
// Kapitel-JOINs liegen ebenfalls hier (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt").

const { db } = require('../connection');
require('../migrations');

const _stmtPronounsPerChapter = db.prepare(`
    SELECT p.chapter_id, c.chapter_name, c.position AS chapter_position, ps.pronoun_counts
    FROM page_stats ps
    JOIN pages p      ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.pronoun_counts IS NOT NULL
  `);

/** pronoun_counts je Seite mit Kapitel-Zuordnung (für die Kapitel-Aggregation). */
function listPronounCountsWithChapters(bookId) {
  return _stmtPronounsPerChapter.all(bookId);
}

const _stmtFigureMentions = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, pfm.count, pfm.first_offset
    FROM page_figure_mentions pfm
    JOIN pages p      ON p.page_id = pfm.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE pfm.figure_id = ? AND p.book_id = ?
    ORDER BY c.position, p.position, p.page_id
  `);

/** Index-Erwähnungen einer Figur je Seite, in Leserichtung. */
function listFigureMentionsWithPages(figureId, bookId) {
  return _stmtFigureMentions.all(figureId, bookId);
}

const _stmtAppearances = db.prepare(`
    SELECT fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE fa.figure_id = ?
    ORDER BY c.position
  `);

/** Kapitel-Auftritte einer Figur mit Kapitelname. */
function listFigureAppearancesWithChapters(figureId) {
  return _stmtAppearances.all(figureId);
}

const _stmtEvents = db.prepare(`
    SELECT fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           fe.chapter_id, c.chapter_name,
           fe.page_id, p.page_name
    FROM figure_events fe
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE fe.figure_id = ?
    ORDER BY fe.sort_order, fe.datum
  `);

/** Lebensereignisse einer Figur mit Kapitel- und Seitenname. */
function listFigureEventsWithPlaces(figureId) {
  return _stmtEvents.all(figureId);
}

const _stmtScenes = db.prepare(`
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE sf.figure_id = ? AND fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order
  `);

/** Szenen, an denen eine Figur beteiligt ist, mit Kapitel- und Seitenname. */
function listFigureScenesWithPlaces(figureId, bookId, userEmail) {
  return _stmtScenes.all(figureId, bookId, userEmail);
}

// ── Lookups (shared.js, tools-plot.js) ──────────────────────────────────────

const _stmtFigureByFigId = db.prepare(
      'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    );

/** Figur per fig_id (exakt), gescoped auf Buch + User (NULL-sicher). */
function getFigureByFigId(bookId, figId, userEmail) {
  return _stmtFigureByFigId.get(bookId, figId, userEmail);
}

const _stmtFiguresForLookup = db.prepare(
      'SELECT id, fig_id, name, kurzname, stale FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY id'
    );

/** Figur per Name auf name/kurzname. Rangfolge: exakter Treffer, dann Wortanfang,
 *  dann Teilstring; bei Gleichstand aktive vor ausgemusterten (stale), dann id.
 *  Der Vergleich läuft in JS mit toLocaleLowerCase — SQLite-LIKE ignoriert die
 *  Gross-/Kleinschreibung nur für ASCII („ä" träfe „Ä" nicht) und behandelt
 *  `%`/`_` im Namen als Platzhalter. Die Figurenliste eines Buchs ist klein. */
function findFigureByName(bookId, userEmail, name) {
  const needle = String(name ?? '').trim().toLocaleLowerCase('de');
  if (!needle) return undefined;
  const rank = (v) => {
    const h = String(v ?? '').toLocaleLowerCase('de');
    if (!h) return 9;
    if (h === needle) return 0;
    if (h.split(/[\s\-]+/).some(w => w.startsWith(needle))) return 1;
    return h.includes(needle) ? 2 : 9;
  };
  let best = null;
  for (const f of _stmtFiguresForLookup.all(bookId, userEmail ?? null)) {
    const r = Math.min(rank(f.name), rank(f.kurzname));
    if (r === 9) continue;
    const key = [r, f.stale ? 1 : 0, f.id];
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
      best = { key, f };
    }
  }
  if (!best) return undefined;
  const { id, fig_id, name: n, kurzname } = best.f;
  return { id, fig_id, name: n, kurzname };
}

const _stmtSceneTitle = db.prepare('SELECT titel AS t FROM figure_scenes WHERE id = ?');

/** Szenentitel per figure_scenes.id; undefined, wenn die Szene fehlt. */
function getSceneTitle(sceneId) {
  return _stmtSceneTitle.get(sceneId)?.t;
}

const _stmtFigureName = db.prepare('SELECT name AS t FROM figures WHERE id = ?');

/** Figurenname per figures.id; undefined, wenn die Figur fehlt. */
function getFigureName(figureId) {
  return _stmtFigureName.get(figureId)?.t;
}

const _stmtSceneTitleForUser = db.prepare('SELECT titel AS t FROM figure_scenes WHERE id = ? AND user_email IS ?');
const _stmtFigureNameForUser = db.prepare('SELECT name AS t FROM figures WHERE id = ? AND user_email IS ?');

/** Szenentitel nur, wenn die Szene dem User gehört (Analyse-Daten sind user-scoped,
 *  der Embedding-Index ist es nicht — er hängt nur am Buch). */
function getSceneTitleForUser(sceneId, userEmail) {
  return _stmtSceneTitleForUser.get(sceneId, userEmail)?.t;
}

/** Figurenname nur, wenn die Figur dem User gehört (siehe getSceneTitleForUser). */
function getFigureNameForUser(figureId, userEmail) {
  return _stmtFigureNameForUser.get(figureId, userEmail)?.t;
}

const _stmtFigureNamesForUser = db.prepare(
    'SELECT fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email = ?'
  );

/** fig_id/name/kurzname aller Figuren von (Buch, User) — `user_email = ?`,
 *  ein leerer/NULL-User matcht also keine NULL-Zeilen. */
function listFigureNamesForUser(bookId, userEmail) {
  return _stmtFigureNamesForUser.all(bookId, userEmail);
}

// ── count_pronouns / get_figure_relations / get_figure_profile ─────────────

const _stmtPronounCounts = db.prepare(
      'SELECT pronoun_counts FROM page_stats WHERE book_id = ? AND pronoun_counts IS NOT NULL'
    );

/** pronoun_counts aller Seiten eines Buchs (buchweite Aggregation). */
function listPronounCounts(bookId) {
  return _stmtPronounCounts.all(bookId);
}

const _stmtRelationsWithNames = db.prepare(`
    SELECT ff.fig_id   AS from_fig_id, ff.name AS from_name,
           ft.fig_id   AS to_fig_id,   ft.name AS to_name,
           r.typ, r.beschreibung, r.machtverhaltnis, r.belege
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
    ORDER BY ff.name, ft.name
  `);

/** Alle Beziehungen von (Buch, User) mit fig_id/Name beider Seiten, nach Namen sortiert. */
function listFigureRelationsWithNames(bookId, userEmail) {
  return _stmtRelationsWithNames.all(bookId, userEmail);
}

/** Knoten-Stammdaten zu einer Menge fig_ids, gescoped auf (Buch, User). Ohne ORDER BY. */
function listFiguresByFigIds(bookId, userEmail, figIds) {
  const ids = [...figIds];
  return db.prepare(
        `SELECT fig_id, name, kurzname, typ FROM figures
           WHERE book_id = ? AND user_email IS ?
             AND fig_id IN (${ids.map(() => '?').join(',')})`
      ).all(bookId, userEmail, ...ids);
}

const _stmtFigureRow = db.prepare(`
    SELECT * FROM figures WHERE id = ?
  `);

/** Vollständige figures-Zeile per id. */
function getFigureRow(figureId) {
  return _stmtFigureRow.get(figureId);
}

const _stmtFigureTags = db.prepare('SELECT tag FROM figure_tags WHERE figure_id = ?');

/** Tags einer Figur (ohne ORDER BY, Einfügereihenfolge der Tabelle). */
function listFigureTagNames(figureId) {
  return _stmtFigureTags.all(figureId).map(t => t.tag);
}

const _stmtRelationsOfFigure = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ff.name AS from_name,
           ft.fig_id AS to_fig_id,   ft.name AS to_name,
           r.typ, r.beschreibung, r.machtverhaltnis
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
      AND (ff.id = ? OR ft.id = ?)
  `);

/** Ein- und ausgehende Beziehungen einer Figur (figures.id) in (Buch, User). */
function listRelationsOfFigure(bookId, userEmail, figureId) {
  return _stmtRelationsOfFigure.all(bookId, userEmail, figureId, figureId);
}

module.exports = {
  getFigureByFigId,
  findFigureByName,
  getSceneTitle,
  getFigureName,
  getSceneTitleForUser,
  getFigureNameForUser,
  listFigureNamesForUser,
  listPronounCounts,
  listFigureRelationsWithNames,
  listFiguresByFigIds,
  getFigureRow,
  listFigureTagNames,
  listRelationsOfFigure,
  listPronounCountsWithChapters,
  listFigureMentionsWithPages,
  listFigureAppearancesWithChapters,
  listFigureEventsWithPlaces,
  listFigureScenesWithPlaces,
};

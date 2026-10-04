'use strict';
// Lesepfad der Fehler-Heatmap. Eigenes db/-Modul, weil die Aggregation
// Seiten-/Kapitelnamen zur Lesezeit braucht: der Namens-JOIN auf `pages`/
// `chapters` gehoert laut CLAUDE.md ("Content-Store-Facade als einziger
// Eintrittspunkt") nicht in den Route-Handler, sondern hierher — Muster
// db/sources/citations.js#listSourceCitations.
//
// Rein lesend, kein Schreibpfad. Die Verdichtung selbst ist pure und liegt in
// [lib/fehler-heatmap.js](../lib/fehler-heatmap.js).

const { db } = require('./connection');

// Seiten des Buchs mit Kapitel-Zuordnung + Woerter-Nenner fuer die Dichte.
// `c.position` ist die Lesereihenfolge (0-basiert, lueckenlos, Depth-First —
// materialisiert von db/book-order.js) und der Sortierschluessel der Zeilen;
// `chapter_id` waere blosse Anlage-Reihenfolge. Muster wie
// db/sources/citations.js#listSourceCitations (ORDER BY c.position, p.position).
const _stmtPages = db.prepare(`
  SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, c.position,
         COALESCE(ps.words, 0) AS words
  FROM pages p
  LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
  LEFT JOIN page_stats ps ON ps.page_id = p.page_id
  WHERE p.book_id = ?
  ORDER BY c.position, p.position
`);

// errors_json aus dem juengsten Check pro Seite = aktueller Findings-Stand.
// `id`/`checked_at` braucht lib/lektorat-findings.js, um zu entscheiden, welche
// Annahmen diesen Stand betreffen.
const _stmtLatestChecks = db.prepare(`
  WITH latest AS (
    SELECT id, page_id, checked_at, errors_json, applied_errors_json,
           ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC, id DESC) AS rn
    FROM page_checks
    WHERE book_id = ? AND user_email = ?
  )
  SELECT id, page_id, checked_at, errors_json, applied_errors_json FROM latest WHERE rn = 1
`);

// Alle Checks mit applied_errors_json — die Union daraus ist kumulativ;
// `saved_at` entscheidet, ob eine Annahme aus einem aelteren Check den
// juengsten Stand noch betrifft (lib/lektorat-findings.js).
// ORDER BY ist Teil des Vertrags, nicht Kosmetik: die Union dedupliziert per
// `original` und behaelt den ERSTEN Treffer. Traegt derselbe Satz in zwei
// Laeufen unterschiedliche `typ`-Werte (Re-Lektorat klassifiziert um), waere
// ohne Sortierung SQL-seitig unbestimmt, welcher gewinnt — mit ihr immer der
// aeltere Lauf.
const _stmtApplied = db.prepare(`
  SELECT id, page_id, checked_at, saved_at, applied_errors_json
  FROM page_checks
  WHERE book_id = ? AND user_email = ? AND applied_errors_json IS NOT NULL
  ORDER BY checked_at ASC, rowid ASC
`);

/** Rohzeilen fuer buildFehlerHeatmap: { pages, checks, appliedRows }. */
function loadHeatmapRows(bookId, userEmail) {
  return {
    pages: _stmtPages.all(bookId),
    checks: _stmtLatestChecks.all(bookId, userEmail),
    appliedRows: _stmtApplied.all(bookId, userEmail),
  };
}

module.exports = { loadHeatmapRows };

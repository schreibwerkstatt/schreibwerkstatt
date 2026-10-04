'use strict';
// Gather-Schicht für den deterministischen Buch-Befund (read-time).
// Sammelt die bereits persistierten Katalog-Zeilen eines Buchs (pro User) und
// übergibt sie an die pure Engine lib/narrative-report.js. Kein KI-Call, kein Cache —
// jeder Aufruf rechnet frisch, reagiert also sofort auf manuelle Figuren-/Szenen-Edits.
//
// Die Kapitel-Achse (Buchreihenfolge) kommt aus chapter_narrative_profile.sort_order:
// die Karte ist Claude-only, das Profil existiert also immer, wenn der Befund gezeigt wird.
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { computeNarrativeReport, NARRATIVE_REPORT_THRESHOLDS } = require('../lib/narrative-report');
const { getBookSettings } = require('./schema');
require('./migrations');

function gatherNarrativeReportData(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;

  // Geordnete Kapitel-Achse aus dem Erzählprofil (SSoT für die Reihenfolge).
  const chapters = db.prepare(`
    SELECT p.chapter_id, c.chapter_name AS kapitel, p.sort_order
      FROM chapter_narrative_profile p
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
     WHERE p.book_id = ? AND p.user_email IS ? AND p.chapter_id IS NOT NULL
     ORDER BY p.sort_order, p.id
  `).all(bookIdInt, email);

  const figures = db.prepare(
    'SELECT id, fig_id, name FROM figures WHERE book_id = ? AND user_email IS ? AND stale = 0'
  ).all(bookIdInt, email);

  const appearances = db.prepare(`
    SELECT fa.figure_id, fa.chapter_id
      FROM figure_appearances fa
      JOIN figures f ON f.id = fa.figure_id
     WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
  `).all(bookIdInt, email);

  const scenes = db.prepare(
    'SELECT id, chapter_id FROM figure_scenes WHERE book_id = ? AND user_email IS ? AND stale = 0'
  ).all(bookIdInt, email);

  const sceneFigures = db.prepare(`
    SELECT sf.scene_id, sf.figure_id
      FROM scene_figures sf
      JOIN figure_scenes fs ON fs.id = sf.scene_id
     WHERE fs.book_id = ? AND fs.user_email IS ? AND fs.stale = 0
  `).all(bookIdInt, email);

  const events = db.prepare(`
    SELECT fe.figure_id, fe.chapter_id
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
     WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0 AND fe.chapter_id IS NOT NULL
  `).all(bookIdInt, email);

  const relations = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ FROM figure_relations WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);

  const locations = db.prepare(
    'SELECT id, loc_id, name FROM locations WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);

  const locationChapters = db.prepare(`
    SELECT lc.location_id, lc.chapter_id
      FROM location_chapters lc
      JOIN locations l ON l.id = lc.location_id
     WHERE l.book_id = ? AND l.user_email IS ?
  `).all(bookIdInt, email);

  // Abweichung zur Lese-Zeit aus der AKTUELLEN Soll-Erzählform berechnen (wie
  // getChapterNarrativeProfile), nicht aus dem beim Lauf gespeicherten Flag.
  const bs = getBookSettings(bookIdInt, email);
  const sollP = bs?.erzaehlperspektive || null;
  const sollT = bs?.erzaehlzeit || null;
  const deviates = (soll, ist) => (soll && soll !== 'gemischt' && ist && ist !== soll) ? 1 : 0;
  const narrative = db.prepare(`
    SELECT chapter_id, perspektive, erzaehlzeit, intensitaet, pov_konfidenz
      FROM chapter_narrative_profile
     WHERE book_id = ? AND user_email IS ?
  `).all(bookIdInt, email).map(r => ({
    chapter_id: r.chapter_id,
    intensitaet: r.intensitaet,
    pov_konfidenz: r.pov_konfidenz,
    pov_abweichung: deviates(sollP, r.perspektive),
    tempus_abweichung: deviates(sollT, r.erzaehlzeit),
  }));

  const themes = db.prepare(`
    SELECT p.chapter_id, t.thema, t.typ
      FROM chapter_narrative_themes t
      JOIN chapter_narrative_profile p ON p.id = t.profile_id
     WHERE p.book_id = ? AND p.user_email IS ?
  `).all(bookIdInt, email);

  return {
    chapters, figures, appearances, scenes, sceneFigures,
    events, relations, locations, locationChapters, narrative, themes,
  };
}

/** Deterministischer Buch-Befund eines Buchs (read-time, pure Engine über gesammelte Zeilen).
 *  Unter MIN_CHAPTERS_FOR_REPORT Kapiteln nur `{ tooFewChapters, chapterCount, minChapters }`:
 *  Präsenz-, Lücken- und Spannen-Befunde über eine Handvoll grosser Kapitel sind Artefakte
 *  der Gliederung (jeder Ort ist «einmalig», kaum eine Figur erreicht drei Kapitel). */
function getNarrativeReport(bookId, userEmail) {
  const data = gatherNarrativeReportData(bookId, userEmail);
  const minChapters = NARRATIVE_REPORT_THRESHOLDS.MIN_CHAPTERS_FOR_REPORT;
  if (data.chapters.length < minChapters) {
    return { tooFewChapters: true, chapterCount: data.chapters.length, minChapters };
  }
  return computeNarrativeReport(data);
}

// ── KI-Dach-Befund (Autoren-Befund) — persistiert je (Buch, User) ────────────────
/** Speichert den vom Job erzeugten Autoren-Befund (JSON) — Upsert pro Buch+User. */
function saveAutorenBefund(bookId, userEmail, report) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const json = JSON.stringify(report || {});
  db.prepare(`
    INSERT INTO narrative_report (book_id, user_email, report_json, updated_at)
    VALUES (?, ?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(book_id, user_email) DO UPDATE SET report_json = excluded.report_json, updated_at = excluded.updated_at
  `).run(bookIdInt, email, json);
}

/** Entfernt einen gespeicherten Autoren-Befund (Buch unter der Kapitel-Schwelle). */
function deleteAutorenBefund(bookId, userEmail) {
  db.prepare('DELETE FROM narrative_report WHERE book_id = ? AND user_email IS ?')
    .run(parseInt(bookId), userEmail || null);
}

/** Liest den gespeicherten Autoren-Befund + Zeitstempel; null wenn keiner existiert. */
function getAutorenBefund(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const row = db.prepare(
    'SELECT report_json, updated_at FROM narrative_report WHERE book_id = ? AND user_email IS ?'
  ).get(bookIdInt, email);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.report_json), updated_at: row.updated_at };
  } catch { return null; }
}

module.exports = { getNarrativeReport, gatherNarrativeReportData, saveAutorenBefund, deleteAutorenBefund, getAutorenBefund };

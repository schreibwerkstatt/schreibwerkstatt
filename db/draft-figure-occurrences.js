'use strict';
// Figuren-Werkstatt — Ist-Index (`draft_figure_occurrences`): wo die psycho-
// logischen Kerne einer Werkstatt-Figur (want/need/wound/lie/bogen/konflikt)
// real im Buchtext auftauchen. Full-Replace pro (Draft, Kern) je Anchor-Lauf;
// abgeleitet, nie von Hand gepflegt. Pendant zu db/motifs/occurrences.js.
//
// Warum pro KERN und nicht pro Figur: „kommt die Figur vor" beantwortet
// figure_appearances laengst. Die offene Frage ist der BOGEN — wo traegt ihre
// Wunde, wo bricht ihre Luege. Das ist eine Verteilung ueber den Buchbogen,
// keine Zahl, und sie braucht die Kern-Achse.

const { db } = require('./connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/motifs/occurrences.js):
// das Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf
// einer noch nicht migrierten DB die Tabelle und der Require wirft.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

// ── Schreibpfad (Full-Replace pro Draft+Kern) ──────────────────────────────

const _stmtDeleteForKern = db.prepare('DELETE FROM draft_figure_occurrences WHERE draft_id = ? AND kern = ?');
const _stmtDeleteForDraft = db.prepare('DELETE FROM draft_figure_occurrences WHERE draft_id = ?');
const _stmtInsertOcc = db.prepare(`
  INSERT INTO draft_figure_occurrences (draft_id, book_id, kern, kind, page_id, scene_id, score, snippet, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

// Full-Replace der Fundstellen EINES Kerns. rows:
// [{ kind:'page'|'scene', pageId?, sceneId?, score, snippet, source }].
const replaceKernOccurrences = db.transaction((draftId, bookId, kern, rows) => {
  _stmtDeleteForKern.run(parseInt(draftId), kern);
  for (const r of rows || []) {
    const isPage = r.kind === 'page';
    _stmtInsertOcc.run(
      parseInt(draftId), parseInt(bookId), kern, r.kind,
      isPage ? parseInt(r.pageId) : null,
      isPage ? null : parseInt(r.sceneId),
      r.score != null ? Number(r.score) : null,
      r.snippet != null ? String(r.snippet).slice(0, 500) : null,
      r.source,
    );
  }
});

// Alle Fundstellen eines Drafts raeumen — fuer Drafts, die gar keinen ausge-
// arbeiteten Kern (mehr) haben. Ohne das bliebe der Index stehen, nachdem der
// Autor den Subtext geleert hat, und das Verlaufsband zeigte einen Bogen, den
// die Mindmap nicht mehr behauptet.
function clearDraftOccurrences(draftId) {
  _stmtDeleteForDraft.run(parseInt(draftId));
}

// ── Lesepfad ───────────────────────────────────────────────────────────────

// Fundstellen-Zahl je (Draft, Kern) — speist die Kern-Plaketten der Draft-Liste
// und die Zeilensummen des Verlaufsbands. avg_score wie bei den Motiven:
// woertliche Treffer (score = null) sind Exakt-Matches und zaehlen als 1.0.
const _stmtCounts = db.prepare(`
  SELECT o.draft_id, o.kern, COUNT(*) AS n, AVG(COALESCE(o.score, 1.0)) AS avg_score
    FROM draft_figure_occurrences o
    JOIN draft_figures d ON d.id = o.draft_id
   WHERE d.book_id = ? AND d.user_email = ?
     AND (o.score IS NULL OR o.score >= ?)
   GROUP BY o.draft_id, o.kern
`);

// Fundstellen je (Draft, Kern, Kapitel) — die Rohdaten des Verlaufsbands und
// der Bogen-Messung. page-Treffer mappen ueber pages.chapter_id, scene-Treffer
// ueber figure_scenes.page_id → pages.chapter_id (wortgleich mit
// db/motifs/occurrences.js#_stmtOccChapters — die Zahl und ihre Aufloesung
// muessen dieselbe Frage stellen).
const _stmtChapters = db.prepare(`
  SELECT o.draft_id, o.kern, COALESCE(pp.chapter_id, sp.chapter_id) AS chapter_id, COUNT(*) AS n
    FROM draft_figure_occurrences o
    JOIN draft_figures d ON d.id = o.draft_id
    LEFT JOIN pages pp ON pp.page_id = o.page_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp ON sp.page_id = s.page_id
   WHERE d.book_id = ? AND d.user_email = ?
     AND (o.score IS NULL OR o.score >= ?)
   GROUP BY o.draft_id, o.kern, COALESCE(pp.chapter_id, sp.chapter_id)
`);

// Fundstellen-Detail eines Drafts (Seiten-/Szenen-Kontext via JOIN, kein
// Snapshot). Kapitel-Aufloesung wortgleich mit _stmtChapters.
const _stmtDetail = db.prepare(`
  SELECT o.id, o.kern, o.kind, o.page_id, o.scene_id, o.score, o.snippet, o.source,
         p.page_name,
         COALESCE(p.chapter_id, sp.chapter_id) AS chapter_id,
         COALESCE(c.chapter_name, sc.chapter_name) AS chapter_name,
         s.titel AS scene_titel, s.page_id AS scene_page_id
    FROM draft_figure_occurrences o
    LEFT JOIN pages p    ON p.page_id = o.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp    ON sp.page_id = s.page_id
    LEFT JOIN chapters sc ON sc.chapter_id = sp.chapter_id
   WHERE o.draft_id = ?
   ORDER BY o.score DESC, o.id
`);

// minScore: Cosinus-Floor (0 = aus). Woertliche Treffer (score = null) sind nie
// betroffen (Exakt-Match) — dieselbe Regel wie im Motiv-Index.
function listDraftOccurrences(draftId, { kern = null, minScore = 0 } = {}) {
  let rows = _stmtDetail.all(parseInt(draftId));
  if (kern) rows = rows.filter(r => r.kern === kern);
  const floor = Number(minScore) || 0;
  if (floor <= 0) return rows;
  return rows.filter(r => r.score == null || r.score >= floor);
}

// Gibt es im Buch ueberhaupt eine Fundstelle? Trennt „nie verankert" von
// „verankert, nichts gefunden" NICHT — genau darum ist die konservative Lesart
// Pflicht: ein leerer Index heisst UNGEPRUEFT, nicht abwesend. Die Bogen-
// Messung (lib/figure-arc.js) liefert dann `scanned: false` statt Befunde,
// gleiches Muster wie `motif_occurrences` und `anchorMap === null` im Plot-Check.
const _stmtHasAny = db.prepare(`
  SELECT 1
    FROM draft_figure_occurrences o
    JOIN draft_figures d ON d.id = o.draft_id
   WHERE d.book_id = ? AND d.user_email = ?
   LIMIT 1
`);
function hasDraftOccurrences(bookId, userEmail) {
  return !!_stmtHasAny.get(parseInt(bookId), userEmail);
}

// Aggregate fuer die Board-/Karten-Payloads. Beide sind pro Buch + User
// skopiert; der Score-Floor wirkt am Lese-Chokepoint PRO FUNDSTELLE und in
// beiden Aggregaten gleich, damit Zeilensumme, Band-Zellen, Zell-Detail und
// Messung dieselbe Menge zaehlen (Muster db/motifs/occurrences.js). Woertliche
// Treffer (score = null) fallen nie. floor <= 0 heisst „aus".
function _floorParam(floor) {
  const f = Number(floor) || 0;
  return f > 0 ? f : -1e9;
}
function occCounts(bookId, userEmail, floor = 0) {
  return _stmtCounts.all(parseInt(bookId), userEmail, _floorParam(floor));
}
function occChapters(bookId, userEmail, floor = 0) {
  return _stmtChapters.all(parseInt(bookId), userEmail, _floorParam(floor));
}

// ── Lauf-Zeitpunkt ─────────────────────────────────────────────────────────
// Wann wurde zuletzt verankert? Eine Scan-Marker-Tabelle gibt es nicht (Full-
// Replace pro Lauf); die Antwort kommt — wie `beatAnchorLastRun` in
// db/plot/anchor.js — aus zwei Signalen: dem juengsten erfolgreichen
// `figur-anchor`-Lauf in `job_runs` (nie geprunt) ODER der juengsten Fundstelle
// (deckt Indizes ohne Job-Spur ab). Ohne den Lauf-Zeitpunkt waere „verankert,
// nichts gefunden" von „nie verankert" nicht zu unterscheiden.
const _stmtLastRun = db.prepare(`
  SELECT MAX(COALESCE(started_at, queued_at)) AS t FROM job_runs
   WHERE type = 'figur-anchor' AND status = 'done' AND book_id = ? AND user_email = ?
`);
const _stmtOccMax = db.prepare(`
  SELECT MAX(o.created_at) AS t
    FROM draft_figure_occurrences o
    JOIN draft_figures d ON d.id = o.draft_id
   WHERE d.book_id = ? AND d.user_email = ?
`);

// ISO+Z und das Alt-Format ('YYYY-MM-DD HH:MM:SS', UTC ohne Z) auf ms.
function _tsMs(s) {
  if (!s) return null;
  const str = String(s);
  const ms = Date.parse(/[TZ]/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Zeitpunkt (ms) des juengsten erfolgreichen Anchor-Laufs; `lastJobRun` trennt
// den Job-Zeitpunkt vom Fundstellen-Fallback (der Aufrufer braucht ihn, um
// „Lauf ohne Treffer" zu erkennen).
function figurAnchorState(bookId, userEmail) {
  const bid = parseInt(bookId);
  const runMs = _tsMs(_stmtLastRun.get(bid, userEmail)?.t);
  const occMs = _tsMs(_stmtOccMax.get(bid, userEmail)?.t);
  const lastMs = Math.max(runMs ?? -Infinity, occMs ?? -Infinity);
  return {
    lastRunMs: Number.isFinite(lastMs) ? lastMs : null,
    lastJobRunMs: runMs,
    hasOccurrences: occMs != null,
  };
}

// Hat sich ein Draft seit der letzten Verankerung bewegt? Dann sind seine Kerne
// ohne Fundstelle UNGEPRUEFT — der Lauf hat einen damals ungeplanten Kern gar
// nicht gesucht. Billige updated_at-Heuristik wie `beatAnchorStale`.
function draftChangedSinceAnchor(draft, lastRunMs) {
  if (lastRunMs == null) return true;
  const upd = _tsMs(draft?.updated_at);
  return upd != null && upd > lastRunMs;
}

// Frischestand: der juengste Draft-Stand gegen den juengsten Anchor-Lauf. Sagt
// „die Mindmap hat sich seit der letzten Verankerung bewegt", nicht „der Text
// hat sich geaendert" (das beantwortet der embed-Index).
const _stmtDraftMax = db.prepare(`
  SELECT MAX(d.updated_at) AS t FROM draft_figures d WHERE d.book_id = ? AND d.user_email = ?
`);
function draftAnchorStale(bookId, userEmail) {
  const draftMs = _tsMs(_stmtDraftMax.get(parseInt(bookId), userEmail)?.t);
  if (draftMs == null) return false;      // keine Drafts → nichts zu verankern
  const { lastRunMs } = figurAnchorState(bookId, userEmail);
  if (lastRunMs == null) return true;     // nie verankert → Knopf anbieten
  return draftMs > lastRunMs;
}

module.exports = {
  replaceKernOccurrences, clearDraftOccurrences,
  listDraftOccurrences, hasDraftOccurrences,
  occCounts, occChapters, draftAnchorStale,
  figurAnchorState, draftChangedSinceAnchor,
};

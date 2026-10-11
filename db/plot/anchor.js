'use strict';
// Beat-Verankerung, Ist-Index (Facade: db/plot.js).

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');

// ── Ist-Index (plot_beat_occurrences) ───────────────────────────────────────
// Abgeleitete Beat-Verankerung: wo ein geplanter Beat semantisch/wörtlich im
// Buchtext auftaucht (Job beat-anchor). Full-Replace pro Beat je Lauf — kein
// Handpflegen, kein content_hash. Pendant zu motifs#replaceOccurrences.

// Lean-Liste für den Anchor-Job: nur die Felder, die als Query dienen + der
// Status für die spätere Drift-Klassifikation. Kein Figuren-/Motiv-Scan.
const _stmtListBeatsForAnchor = db.prepare(`
  SELECT id, titel, beschreibung, status, verworfen
    FROM plot_beats
   WHERE book_id = ? AND user_email = ?
`);
function listBeatsForAnchor(bookId, userEmail) {
  return _stmtListBeatsForAnchor.all(parseInt(bookId), userEmail);
}

const _stmtDeleteOccForBeat = db.prepare('DELETE FROM plot_beat_occurrences WHERE beat_id = ?');
const _stmtInsertBeatOcc = db.prepare(`
  INSERT INTO plot_beat_occurrences (beat_id, book_id, kind, page_id, scene_id, score, snippet, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

// Full-Replace der Fundstellen eines Beats (ein Anchor-Ergebnis). rows:
// [{ kind:'page'|'scene', pageId?, sceneId?, score, snippet, source }].
// score = roher Cosinus (semantisch) bzw. null (wörtlicher FTS-Treffer).
// Rückgabe false, wenn der Beat inzwischen gelöscht ist (Lauf überholt von einem
// Delete) — dann wird nichts geschrieben statt am FK zu scheitern.
const _stmtBeatExists = db.prepare('SELECT 1 FROM plot_beats WHERE id = ?');
const replaceBeatOccurrences = db.transaction((beatId, bookId, rows) => {
  if (!_stmtBeatExists.get(parseInt(beatId))) return false;
  _stmtDeleteOccForBeat.run(parseInt(beatId));
  for (const r of rows || []) {
    const isPage = r.kind === 'page';
    _stmtInsertBeatOcc.run(
      parseInt(beatId), parseInt(bookId), r.kind,
      isPage ? parseInt(r.pageId) : null,
      isPage ? null : parseInt(r.sceneId),
      r.score != null ? Number(r.score) : null,
      r.snippet != null ? String(r.snippet).slice(0, 500) : null,
      r.source,
    );
  }
  return true;
});

// Alle Fundstellen der Beats eines Buchs am Stück (Seiten-/Szenen-Kontext via
// JOIN, kein Snapshot) → Map beat_id → { count, top[] }. Der Board-Payload hängt
// count + die Top-Treffer (nach Score) an jeden Beat fürs Drift-Badge. Szenen
// erben ihre Seite (figure_scenes.page_id) fürs Anspringen.
const _OCC_SELECT = `
  SELECT o.beat_id, o.kind, o.score, o.snippet, o.source,
         COALESCE(o.page_id, s.page_id) AS page_id,
         COALESCE(p.page_name, sp.page_name) AS page_name,
         s.titel AS scene_titel
    FROM plot_beat_occurrences o
    JOIN plot_beats b ON b.id = o.beat_id
    LEFT JOIN pages p         ON p.page_id = o.page_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp        ON sp.page_id = s.page_id
`;
const _stmtBeatOccForBook = db.prepare(`${_OCC_SELECT} WHERE b.book_id = ? AND b.user_email = ? ORDER BY o.score DESC, o.id`);
const _stmtBeatOccForBeat = db.prepare(`${_OCC_SELECT} WHERE o.beat_id = ? ORDER BY o.score DESC, o.id`);
const BEAT_OCC_TOP_N = 8;
// opts.minScore: Score-Floor (0 = aus) — blendet schwache semantische Treffer aus
// count UND top aus, damit Drift-Badge-Zahl und Popover-Liste konsistent bleiben.
// `score` ist der rohe Cosinus (beat-anchor.js speichert semScore), der Floor
// vergleicht also Cosinus gegen Cosinus. FTS-/Trigger-Treffer haben score=null
// (wörtlicher Match) → nie vom Floor betroffen.
// opts.navigableOnly: nicht anspringbare Fundstellen (Szene ohne verknüpfte Seite,
// page_id null) überspringen — ein Ziel ohne Seite kann man nicht öffnen.
function beatOccurrenceMap(bookId, userEmail, opts = {}) {
  return _aggregateOcc(_stmtBeatOccForBook.all(parseInt(bookId), userEmail), opts);
}

// Dieselbe Aggregation für EINEN Beat (Antwort von POST/PATCH /plot/beats — ohne
// buchweiten Scan). Rückgabe { count, top[] } (count 0 / top [] ohne Fundstellen).
function beatOccurrenceEntry(beatId, opts = {}) {
  return _aggregateOcc(_stmtBeatOccForBeat.all(parseInt(beatId)), opts).get(parseInt(beatId))
    || { count: 0, top: [] };
}

function _aggregateOcc(rows, opts) {
  const minScore = Number(opts.minScore) || 0;
  const navigableOnly = !!opts.navigableOnly;
  const map = new Map();
  for (const r of rows) {
    if (navigableOnly && !r.page_id) continue;
    if (minScore > 0 && r.score != null && r.score < minScore) continue;
    let e = map.get(r.beat_id);
    if (!e) { e = { count: 0, top: [] }; map.set(r.beat_id, e); }
    e.count += 1;
    if (e.top.length < BEAT_OCC_TOP_N) {
      e.top.push({
        kind: r.kind, page_id: r.page_id, page_name: r.page_name,
        scene_titel: r.scene_titel, snippet: r.snippet, score: r.score, source: r.source,
      });
    }
  }
  return map;
}

// Stale-Heuristik fürs „Verankerung aktualisieren"-Angebot: gibt es Beats, deren
// Anker-relevanter Inhalt sich seit dem letzten Anchor-Lauf geändert hat (oder lief
// noch nie einer)?
//
// Zeitpunkt des letzten Laufs: Start des jüngsten erfolgreich beendeten
// `beat-anchor`-Jobs dieses (Buch, User) aus job_runs — ein Lauf mit 0 Fundstellen
// zählt damit genauso als „gelaufen" wie einer mit Treffern (aus den Fundstellen
// allein wäre er unsichtbar). Der START, nicht das Ende: ein während des Laufs
// geänderter Beat gilt danach weiter als veraltet. job_runs wird nach der Aufbewahrungsfrist
// geprunt; der Nacht-Cron (anchorAllBooks) verankert jeden Scope mit Beats täglich
// neu, und MAX(occurrences.created_at) bleibt als zweite Quelle — verschwindet die
// Spur trotzdem, bietet die Karte schlimmstenfalls einen überflüssigen Neulauf an.
//
// Inhaltszeit: plot_beats.content_updated_at — gestempelt nur von titel/
// beschreibung/status/verworfen (ANCHOR_CONTENT_COLS), nicht von DnD, Fork oder
// Kapitel/Intensität/Figuren. Berücksichtigt werden die Beats, die verankert werden
// (nicht verworfen, Status in `statuses`), PLUS Beats, die noch Fundstellen tragen
// (deren Rückstufung/Verwerfen räumt erst der nächste Lauf ab).
// `statuses` = immer `im_buch`; zusätzlich `geplant`, wenn die Promotion-Erkennung
// aktiv ist (plot.anchor.promote_min_score > 0 — der Aufrufer entscheidet, damit
// die reine DB-Schicht die App-Setting nicht lesen muss).
const _STALE_ALLOWED_STATUS = new Set(['im_buch', 'geplant']);
const _stmtLastAnchorRun = db.prepare(`
  SELECT MAX(COALESCE(started_at, queued_at)) AS t FROM job_runs
   WHERE type = 'beat-anchor' AND status = 'done' AND book_id = ? AND user_email = ?
`);
// ISO+Z ('…T…Z') und das Alt-Format ('YYYY-MM-DD HH:MM:SS', UTC ohne Z) auf ms.
function _tsMs(s) {
  if (!s) return null;
  const str = String(s);
  const ms = Date.parse(/[TZ]/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}
// Zeitpunkt des jüngsten Anker-Laufs (ISO) oder null = nie verankert. Speist
// `beatAnchor.ranAt` im Board-Payload: ohne je gelaufene Verankerung ist ein
// `im_buch`-Beat ohne Fundstelle „unbekannt", nicht „drift".
function beatAnchorLastRun(bookId, userEmail) {
  const bid = parseInt(bookId);
  const runMs = _tsMs(_stmtLastAnchorRun.get(bid, userEmail)?.t);
  const occ = db.prepare(`
    SELECT MAX(o.created_at) AS t FROM plot_beat_occurrences o
      JOIN plot_beats b ON b.id = o.beat_id
     WHERE b.book_id = ? AND b.user_email = ?
  `).get(bid, userEmail);
  const ms = Math.max(runMs ?? -Infinity, _tsMs(occ?.t) ?? -Infinity);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function beatAnchorStale(bookId, userEmail, statuses = ['im_buch']) {
  const bid = parseInt(bookId);
  const allowed = statuses.filter(s => _STALE_ALLOWED_STATUS.has(s));
  if (!allowed.length) return false;
  const ph = allowed.map(() => '?').join(',');
  const r = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM plot_beats WHERE book_id = ? AND user_email = ? AND verworfen = 0 AND status IN (${ph})) AS beats,
      (SELECT MAX(b.content_updated_at) FROM plot_beats b
        WHERE b.book_id = ? AND b.user_email = ?
          AND ((b.verworfen = 0 AND b.status IN (${ph}))
               OR EXISTS (SELECT 1 FROM plot_beat_occurrences o WHERE o.beat_id = b.id))) AS content_max,
      (SELECT MAX(o.created_at) FROM plot_beat_occurrences o
         JOIN plot_beats b ON b.id = o.beat_id
        WHERE b.book_id = ? AND b.user_email = ?) AS occ_max
  `).get(bid, userEmail, ...allowed, bid, userEmail, ...allowed, bid, userEmail);
  if (!r || !r.beats) return false;          // nichts zu verankern → nicht stale
  const runMs = Math.max(_tsMs(_stmtLastAnchorRun.get(bid, userEmail)?.t) ?? -Infinity, _tsMs(r.occ_max) ?? -Infinity);
  if (!Number.isFinite(runMs)) return true;  // noch nie gelaufen
  const contentMs = _tsMs(r.content_max);
  return contentMs != null && contentMs > runMs; // Inhalt seit letztem Lauf geändert
}

module.exports = {
  listBeatsForAnchor, replaceBeatOccurrences, beatOccurrenceMap, beatOccurrenceEntry, beatAnchorStale,
  beatAnchorLastRun,
};

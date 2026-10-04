'use strict';
// Beats der Plot-Werkstatt (Facade: db/plot.js): CRUD, Figuren-/Orts-/Motiv-
// Brücken, Zell-Reorder und die Kapitel-Zähler für die Verknüpfungs-Indikatoren.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { _codedError, _posInt } = require('./shared');
const { getAct, _validThreadId, actFitsThread, _renumberCell } = require('./structure');

// ── Beats ──────────────────────────────────────────────────────────────────

const _BEAT_SELECT = `
  SELECT b.id, b.book_id, b.act_id, b.thread_id, b.user_email, b.titel, b.beschreibung,
         b.status, b.verworfen, b.chapter_id, c.chapter_name, b.intensitaet, b.zeit, b.sort_order,
         b.created_at, b.updated_at
    FROM plot_beats b
    LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
`;
const _stmtListBeats = db.prepare(`
  ${_BEAT_SELECT}
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY b.act_id, b.sort_order, b.id
`);
const _stmtGetBeat = db.prepare(`${_BEAT_SELECT} WHERE b.id = ?`);
const _stmtInsertBeat = db.prepare(`
  INSERT INTO plot_beats (book_id, act_id, thread_id, user_email, titel, beschreibung, status, verworfen, chapter_id, intensitaet, zeit, sort_order, created_at, updated_at, content_updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
// Die Spalten, deren Änderung den Verankerungs-Index veraltet: titel +
// beschreibung sind die Anker-Query, status + verworfen entscheiden, OB und mit
// welcher Schwelle ein Beat verankert wird (beat-anchor.js). Nur sie stempeln
// content_updated_at — DnD, Fork, Kapitel/Intensität/Zeit/Figuren nicht.
const ANCHOR_CONTENT_COLS = new Set(['titel', 'beschreibung', 'status', 'verworfen']);
const _stmtDeleteBeat = db.prepare('DELETE FROM plot_beats WHERE id = ?');
// sort_order ist pro ZELLE (act_id, thread_id) lückenlos. thread_id IS ? ist
// NULL-safe (gebundener NULL-Parameter → „ohne Strang"-Lane).
const _stmtMaxBeatOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plot_beats WHERE act_id = ? AND thread_id IS ?');
const _stmtSetBeatSlot = db.prepare(`
  UPDATE plot_beats SET act_id = ?, thread_id = ?, sort_order = ?, updated_at = ${NOW_ISO_SQL}
   WHERE id = ? AND book_id = ? AND user_email = ?
`);

// Figuren-Links pro Beat. plot_beat_figures.figure_id ist INTEGER-FK auf
// figures.id; nach aussen wird aber die TEXT-fig_id exponiert bzw. erwartet —
// das ist die Figur-Identität, mit der das Frontend arbeitet ($app.figuren[].id
// === fig_id, vgl. routes/figures.js). resolveFigureIds übersetzt eingehende
// fig_ids → figures.id, die Lese-Aggregate liefern fig_id zurück.
const _stmtListFigsForBook = db.prepare(`
  SELECT pbf.beat_id, f.fig_id AS fig_id
    FROM plot_beat_figures pbf
    JOIN plot_beats b ON b.id = pbf.beat_id
    JOIN figures   f ON f.id = pbf.figure_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
// Figuren EINES Beats (für _beatRow ohne vorgebaute Buch-Map — verhindert den
// buchweiten Link-Scan bei jeder Einzel-Beat-Mutation/-Lesung).
const _stmtFigsForBeat = db.prepare(`
  SELECT f.fig_id AS fig_id
    FROM plot_beat_figures pbf
    JOIN figures f ON f.id = pbf.figure_id
   WHERE pbf.beat_id = ?
`);
const _stmtDeleteFigsForBeat = db.prepare('DELETE FROM plot_beat_figures WHERE beat_id = ?');
const _stmtInsertFig = db.prepare('INSERT OR IGNORE INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)');

// Werkstatt-Figuren (draft_figures) pro Beat. Anders als bei plot_beat_figures
// IST die draft_figures.id (INTEGER) bereits die Frontend-Identität — keine
// TEXT-fig_id-Indirektion. Lese-Aggregat liefert die INTEGER-id direkt zurück.
const _stmtListDraftFigsForBook = db.prepare(`
  SELECT pbdf.beat_id, pbdf.draft_figure_id AS draft_id
    FROM plot_beat_draft_figures pbdf
    JOIN plot_beats b ON b.id = pbdf.beat_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
// Werkstatt-Figuren EINES Beats (Pendant zu _stmtFigsForBeat).
const _stmtDraftFigsForBeat = db.prepare(`
  SELECT pbdf.draft_figure_id AS draft_id
    FROM plot_beat_draft_figures pbdf
   WHERE pbdf.beat_id = ?
`);
const _stmtDeleteDraftFigsForBeat = db.prepare('DELETE FROM plot_beat_draft_figures WHERE beat_id = ?');
const _stmtInsertDraftFig = db.prepare('INSERT OR IGNORE INTO plot_beat_draft_figures (beat_id, draft_figure_id) VALUES (?, ?)');

// Schauplätze pro Beat — WO der Handlungspunkt spielt. Vierte Brücke neben
// Katalog-Figur, Werkstatt-Figur und Motiv, und dieselbe TEXT/INTEGER-Indirektion
// wie bei den Figuren: `plot_beat_locations.location_id` ist INTEGER-FK auf
// `locations.id`, nach aussen exponiert wird die TEXT-`loc_id` (Frontend-Identität,
// vgl. routes/locations.js, das `id: r.loc_id` mappt).
//
// Der Ort ist ein dramaturgisches Werkzeug (die Konfrontation findet dort statt,
// wo es anfing) — ohne die Brücke kann weder die Konsistenzprüfung noch der
// Brainstorm über Schauplätze urteilen.
const _stmtListLocsForBook = db.prepare(`
  SELECT pbl.beat_id, l.loc_id AS loc_id, l.name
    FROM plot_beat_locations pbl
    JOIN plot_beats b ON b.id = pbl.beat_id
    JOIN locations  l ON l.id = pbl.location_id
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY l.sort_order, l.id
`);
// Schauplätze EINES Beats (Pendant zu _stmtFigsForBeat — Einzel-Beat-Pfad ohne Buch-Map).
const _stmtLocsForBeat = db.prepare(`
  SELECT l.loc_id AS loc_id, l.name
    FROM plot_beat_locations pbl
    JOIN locations l ON l.id = pbl.location_id
   WHERE pbl.beat_id = ?
   ORDER BY l.sort_order, l.id
`);
const _stmtDeleteLocsForBeat = db.prepare('DELETE FROM plot_beat_locations WHERE beat_id = ?');
const _stmtInsertLoc = db.prepare('INSERT OR IGNORE INTO plot_beat_locations (beat_id, location_id) VALUES (?, ?)');

// Motiv-Soll-Verknüpfungen pro Beat — read-only Anzeige im Plot. `motif_beats` ist
// eine der M:M-Soll-Brücken der Motiv-Werkstatt; kuratiert wird sie dort, der Plot
// zeigt sie nur als Entitäts-Referenz (Klick → Motiv-Werkstatt). `farbe` = eigene
// Motiv-Farbe, sonst die des zugeordneten Themas (wie im Konstellations-Graph).
// Scoping über den Beat (Buch + User); die verknüpften
// Motive tragen denselben Scope (Motiv-Werkstatt ist pro Buch + User isoliert).
const _stmtListMotifsForBook = db.prepare(`
  SELECT mb.beat_id, m.id AS motif_id, m.name, COALESCE(m.farbe, t.farbe) AS farbe
    FROM motif_beats mb
    JOIN plot_beats b ON b.id = mb.beat_id
    JOIN motifs     m ON m.id = mb.motif_id
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY m.position, m.id
`);
// Motive EINES Beats (Pendant zu _stmtFigsForBeat — Einzel-Beat-Pfad ohne Buch-Map).
const _stmtMotifsForBeat = db.prepare(`
  SELECT m.id AS motif_id, m.name, COALESCE(m.farbe, t.farbe) AS farbe
    FROM motif_beats mb
    JOIN motifs m ON m.id = mb.motif_id
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE mb.beat_id = ?
   ORDER BY m.position, m.id
`);
// Schreibpfad Beat → Motiv (dieselbe motif_beats-Brücke, andere Achse): Full-Replace
// pro Beat. Berührt nur Zeilen WHERE beat_id = ? — kollidiert nicht mit dem
// Motiv-seitigen Full-Replace (setMotifBeats, WHERE motif_id = ?). So kuratiert
// der Plot dieselbe Verknüpfung von der Beat-Seite, ohne die Motiv-Werkstatt zu stören.
const _stmtDeleteMotifsForBeat = db.prepare('DELETE FROM motif_beats WHERE beat_id = ?');
const _stmtInsertBeatMotif = db.prepare('INSERT OR IGNORE INTO motif_beats (motif_id, beat_id) VALUES (?, ?)');

// TEXT-fig_id (Frontend-Identität) → INTEGER figures.id (FK-Target), gefiltert
// aufs Subset, das wirklich zu (Buch, User) gehört. Unbekannte/Fremd-fig_ids
// fallen still raus (kein Cross-Buch-Leak in die M:M-Tabelle).
function resolveFigureIds(bookId, userEmail, figIds) {
  if (!Array.isArray(figIds) || !figIds.length) return [];
  const wanted = figIds.map(x => String(x).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM figures WHERE book_id = ? AND user_email = ? AND fig_id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

// Schlanke Figuren-Identitäten (figures.id ↔ TEXT-fig_id + Name) des (Buch,
// User)-Katalogs — für die Zeit-Messung, die nur Name + Geburtsjahr braucht
// (Geburtsjahr liefert lib/figure-years.js#computeFigureYears, keyed by figures.id).
const _stmtFigureIdentities = db.prepare('SELECT id, fig_id, name FROM figures WHERE book_id = ? AND user_email = ?');
function listFigureIdentities(bookId, userEmail) {
  return _stmtFigureIdentities.all(parseInt(bookId), userEmail);
}

// TEXT-loc_id (Frontend-Identität) → INTEGER locations.id, gefiltert aufs Subset
// des Buchs. Unbekannte/Fremd-loc_ids fallen still raus (kein Cross-Buch-Leak in
// die M:M-Tabelle) — wortgleiches Muster zu resolveFigureIds.
//
// Anders als bei `figures` gibt es an `locations` KEINE user_email-Achse im
// Katalog-Sinn (die Orte-Tabelle ist buchweit gepflegt), darum filtert dieser
// Resolver nur über book_id.
function resolveLocationIds(bookId, locIds) {
  if (!Array.isArray(locIds) || !locIds.length) return [];
  const wanted = locIds.map(x => String(x).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM locations WHERE book_id = ? AND loc_id IN (${placeholders})`
  ).all(parseInt(bookId), ...wanted).map(r => r.id);
}

// Werkstatt-Figur-IDs (INTEGER draft_figures.id) aufs Subset filtern, das wirklich
// zu (Buch, User) gehört. Unbekannte/Fremd-IDs fallen still raus (kein Cross-Buch-
// Leak in die M:M-Tabelle). Eingang sind bereits INTEGER-IDs (Frontend-Identität).
function resolveDraftFigureIds(bookId, userEmail, draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length) return [];
  const wanted = draftIds.map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM draft_figures WHERE book_id = ? AND user_email = ? AND id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

// Motiv-IDs (INTEGER motifs.id) aufs (Buch, User)-Subset filtern — kein Cross-Buch-
// Leak in die motif_beats-Brücke. Motive gehören zur Motiv-Werkstatt (pro Buch + User).
function resolveMotifIds(bookId, userEmail, motifIds) {
  if (!Array.isArray(motifIds) || !motifIds.length) return [];
  const wanted = motifIds.map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM motifs WHERE book_id = ? AND user_email = ? AND id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

function _figMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.fig_id);
  }
  return map;
}

function _draftFigMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListDraftFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.draft_id);
  }
  return map;
}

function _locMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListLocsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push({ id: r.loc_id, name: r.name });
  }
  return map;
}

function _motifMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListMotifsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push({ id: r.motif_id, name: r.name, farbe: r.farbe });
  }
  return map;
}

// figureIds = INTEGER figures.id (bereits via resolveFigureIds aufgelöst).
function _setBeatFigures(beatId, figureIds) {
  _stmtDeleteFigsForBeat.run(parseInt(beatId));
  for (const fid of (figureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertFig.run(parseInt(beatId), parseInt(fid));
  }
}

// draftFigureIds = INTEGER draft_figures.id (bereits via resolveDraftFigureIds aufgelöst).
function _setBeatDraftFigures(beatId, draftFigureIds) {
  _stmtDeleteDraftFigsForBeat.run(parseInt(beatId));
  for (const fid of (draftFigureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertDraftFig.run(parseInt(beatId), parseInt(fid));
  }
}

// motifIds = INTEGER motifs.id (bereits via resolveMotifIds aufgelöst). Full-Replace
// pro Beat: alle Motiv-Links dieses Beats löschen, die gewählten neu setzen.
// locationIds = INTEGER locations.id (bereits via resolveLocationIds aufgelöst).
function _setBeatLocations(beatId, locationIds) {
  _stmtDeleteLocsForBeat.run(parseInt(beatId));
  for (const lid of (locationIds || [])) {
    if (Number.isInteger(lid) || /^\d+$/.test(String(lid))) _stmtInsertLoc.run(parseInt(beatId), parseInt(lid));
  }
}

function _setBeatMotifs(beatId, motifIds) {
  _stmtDeleteMotifsForBeat.run(parseInt(beatId));
  for (const mid of (motifIds || [])) {
    if (Number.isInteger(mid) || /^\d+$/.test(String(mid))) _stmtInsertBeatMotif.run(parseInt(mid), parseInt(beatId));
  }
}

function _beatRow(beatId, figMap = null, draftFigMap = null, motifMap = null, locMap = null) {
  const r = _stmtGetBeat.get(parseInt(beatId));
  if (!r) return null;
  // Ohne vorgebaute Buch-Map (Einzel-Beat-Pfad) gezielt nur die Links DIESES
  // Beats laden — kein buchweiter Scan pro Mutation/Lesung.
  const figs = figMap ? (figMap[r.id] || []) : _stmtFigsForBeat.all(r.id).map(x => x.fig_id);
  const draftFigs = draftFigMap ? (draftFigMap[r.id] || []) : _stmtDraftFigsForBeat.all(r.id).map(x => x.draft_id);
  const motifs = motifMap ? (motifMap[r.id] || []) : _stmtMotifsForBeat.all(r.id).map(x => ({ id: x.motif_id, name: x.name, farbe: x.farbe }));
  const locs = locMap ? (locMap[r.id] || []) : _stmtLocsForBeat.all(r.id).map(x => ({ id: x.loc_id, name: x.name }));
  return { ...r, fig_ids: figs, draft_fig_ids: draftFigs, motifs, locations: locs };
}

function listBeats(bookId, userEmail) {
  const figMap = _figMapForBook(bookId, userEmail);
  const draftFigMap = _draftFigMapForBook(bookId, userEmail);
  const motifMap = _motifMapForBook(bookId, userEmail);
  const locMap = _locMapForBook(bookId, userEmail);
  return _stmtListBeats.all(parseInt(bookId), userEmail)
    .map(r => ({
      ...r,
      fig_ids: figMap[r.id] || [], draft_fig_ids: draftFigMap[r.id] || [],
      motifs: motifMap[r.id] || [], locations: locMap[r.id] || [],
    }));
}

const createBeat = db.transaction((bookId, actId, userEmail, { titel, beschreibung = null, status = 'geplant', verworfen = 0, chapterId = null, intensitaet = null, zeit = null, threadId = null, figureIds = [], draftFigureIds = [], motifIds = [], locationIds = [], sortOrder = null }) => {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = sortOrder != null ? parseInt(sortOrder) : (_stmtMaxBeatOrder.get(parseInt(actId), tid).m + 1);
  const info = _stmtInsertBeat.run(
    parseInt(bookId), parseInt(actId), tid, userEmail, titel, beschreibung, status, verworfen ? 1 : 0,
    chapterId != null ? parseInt(chapterId) : null,
    intensitaet != null ? parseInt(intensitaet) : null, zeit, pos
  );
  _setBeatFigures(info.lastInsertRowid, figureIds);
  _setBeatDraftFigures(info.lastInsertRowid, draftFigureIds);
  _setBeatMotifs(info.lastInsertRowid, motifIds);
  _setBeatLocations(info.lastInsertRowid, locationIds);
  return _beatRow(info.lastInsertRowid);
});

// Partielles Update: nur übergebene Felder ändern. `fields` enthält bereits
// validierte Werte; `figureIds`/`draftFigureIds` (falls Array) ersetzen die
// jeweiligen Figuren-Links komplett.
//
// Zellwechsel (act_id und/oder thread_id ändern die Zelle): der Beat landet am
// ENDE der Zielzelle, die Quellzelle wird lückenlos neu nummeriert.
const updateBeat = db.transaction((id, fields, figureIds, draftFigureIds, motifIds, locationIds) => {
  const before = _stmtGetBeat.get(parseInt(id));
  const sets = [];
  const vals = [];
  const f = { ...fields };
  let cellChanged = false;
  if (before && ('act_id' in f || 'thread_id' in f)) {
    const toAct = 'act_id' in f ? f.act_id : before.act_id;
    const toThread = 'thread_id' in f ? (f.thread_id ?? null) : (before.thread_id ?? null);
    cellChanged = toAct !== before.act_id || toThread !== (before.thread_id ?? null);
    if (cellChanged && !('sort_order' in f)) {
      f.sort_order = _stmtMaxBeatOrder.get(parseInt(toAct), toThread).m + 1;
    }
  }
  let contentChanged = false;
  for (const [col, val] of Object.entries(f)) {
    sets.push(`${col} = ?`);
    vals.push(val);
    if (ANCHOR_CONTENT_COLS.has(col) && before && before[col] !== val) contentChanged = true;
  }
  if (sets.length) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    if (contentChanged) sets.push(`content_updated_at = ${NOW_ISO_SQL}`);
    vals.push(parseInt(id));
    db.prepare(`UPDATE plot_beats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (cellChanged) _renumberCell(before.book_id, before.user_email, before.act_id, before.thread_id ?? null);
  if (Array.isArray(figureIds)) _setBeatFigures(id, figureIds);
  if (Array.isArray(draftFigureIds)) _setBeatDraftFigures(id, draftFigureIds);
  if (Array.isArray(motifIds)) _setBeatMotifs(id, motifIds);
  if (Array.isArray(locationIds)) _setBeatLocations(id, locationIds);
  return _beatRow(id);
});

function getBeat(id) {
  return _beatRow(id);
}

// Leichtgewichtiger Beat-Stamm (ohne Figuren-Arrays) für Owner-/Scope-Checks in
// den Routen. Trägt book_id/user_email/act_id/thread_id — alles, was die
// PATCH/DELETE-Handler zur Autorisierung + Hybrid-Akt-Prüfung brauchen, ohne den
// (per Beat sonst günstigen, aber unnötigen) Figuren-Aufbau von getBeat.
function getBeatMeta(id) {
  return _stmtGetBeat.get(parseInt(id)) || null;
}

// Map page_id → Anzahl nicht-verworfener Beats, die mit dem Kapitel der Seite
// verknüpft sind. Beats hängen über chapter_id am Kapitel (kein page_id), darum
// wird der Kapitel-Count auf jede Seite des Kapitels projiziert. Speist den
// Plot-Verknüpfungs-Indikator im Notebook-Editor (analog /research/page-counts).
function pageBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT p.page_id AS page_id, COUNT(*) AS n
      FROM plot_beats b
      JOIN pages p ON p.chapter_id = b.chapter_id
     WHERE b.book_id = ? AND b.user_email = ? AND b.verworfen = 0
       AND b.chapter_id IS NOT NULL
     GROUP BY p.page_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.page_id] = r.n;
  return map;
}

// Map chapter_id → Anzahl nicht-verworfener Beats im Kapitel. Speist den
// Plot-Verknüpfungs-Indikator in der Kapitelansicht (analog zur Page-Variante,
// aber ohne Projektion — Beats hängen direkt am Kapitel).
function chapterBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT chapter_id, COUNT(*) AS n
      FROM plot_beats
     WHERE book_id = ? AND user_email = ? AND verworfen = 0
       AND chapter_id IS NOT NULL
     GROUP BY chapter_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.chapter_id] = r.n;
  return map;
}

// Beat löschen + seine Zelle lückenlos nachziehen.
const deleteBeat = db.transaction((id) => {
  const b = _stmtGetBeat.get(parseInt(id));
  _stmtDeleteBeat.run(parseInt(id));
  if (b) _renumberCell(b.book_id, b.user_email, b.act_id, b.thread_id ?? null);
});

// Beats neu einsortieren (Drag zwischen/innerhalb Zellen). order = [{ actId,
// threadId, beatIds: [...] }] — pro Zelle (Akt × Strang) die Beat-IDs in
// Zielreihenfolge. Setzt act_id + thread_id + sort_order in einem Rutsch.
// threadId fehlt/null → „ohne Strang"-Lane (Abwärtskompat zum flachen Board).
//
// Erst wird der GANZE Payload geprüft, dann geschrieben; jeder Verstoss wirft
// einen .code und rollt die Transaktion zurück (nichts geschrieben):
//   ORDER_INVALID       — Gruppe kein Objekt, actId keine Ganzzahl, beatIds kein
//                         Array, threadId ungültig/fremd, Beat-ID unbekannt/fremd
//                         oder doppelt
//   ACT_MISMATCH        — Ziel-Akt gehört nicht zu (Buch, User)
//   ACT_THREAD_MISMATCH — Akt passt nicht zum Strang (actFitsThread); geprüft nur
//                         für Gruppen mit Beats (eine leere Quellzelle bewegt nichts)
// Danach ist jede berührte Zelle lückenlos: Zielzellen in Payload-Reihenfolge
// (nicht genannte Beats der Zelle dahinter), Quellzellen verlassener Beats neu
// durchnummeriert.
const reorderBeats = db.transaction((bookId, userEmail, order) => {
  const bid = parseInt(bookId);
  if (!Array.isArray(order)) throw _codedError('ORDER_INVALID');
  const groups = [];
  const seen = new Set();
  for (const grp of order) {
    if (!grp || typeof grp !== 'object' || Array.isArray(grp)) throw _codedError('ORDER_INVALID');
    const actId = _posInt(grp.actId);
    if (actId == null || !Array.isArray(grp.beatIds)) throw _codedError('ORDER_INVALID');
    let threadId = null;
    if (grp.threadId != null && grp.threadId !== '') {
      threadId = _validThreadId(bid, userEmail, _posInt(grp.threadId));
      if (threadId == null) throw _codedError('ORDER_INVALID');
    }
    const act = getAct(actId);
    if (!act || act.book_id !== bid || act.user_email !== userEmail) throw _codedError('ACT_MISMATCH');
    const beatIds = grp.beatIds.map(_posInt);
    if (beatIds.some(x => x == null)) throw _codedError('ORDER_INVALID');
    for (const beatId of beatIds) {
      if (seen.has(beatId) || !_beatBelongs(bid, userEmail, beatId)) throw _codedError('ORDER_INVALID');
      seen.add(beatId);
    }
    if (beatIds.length && !actFitsThread(act, threadId)) throw _codedError('ACT_THREAD_MISMATCH');
    groups.push({ actId, threadId, beatIds });
  }

  // Quellzellen der bewegten Beats VOR dem Schreiben merken.
  const cellKey = (a, t) => `${a}:${t ?? ''}`;
  const sources = new Map();
  for (const g of groups) {
    for (const beatId of g.beatIds) {
      const b = _stmtGetBeat.get(beatId);
      sources.set(cellKey(b.act_id, b.thread_id), [b.act_id, b.thread_id ?? null]);
    }
  }
  for (const g of groups) {
    g.beatIds.forEach((beatId, idx) => {
      _stmtSetBeatSlot.run(g.actId, g.threadId, idx, beatId, bid, userEmail);
    });
  }
  // Erst nach ALLEN Moves nummerieren — eine spätere Gruppe kann einen Beat aus
  // einer früheren Zielzelle wieder herausziehen. Nicht genannte Beats einer
  // Zielzelle rücken hinter die genannten (kein Doppel-Slot).
  const targets = new Set();
  for (const g of groups) {
    _renumberCell(bid, userEmail, g.actId, g.threadId, g.beatIds);
    targets.add(cellKey(g.actId, g.threadId));
  }
  for (const [key, [a, t]] of sources) {
    if (!targets.has(key)) _renumberCell(bid, userEmail, a, t);
  }
});

// Prueft, ob ein Beat wirklich zu (Buch, User) gehoert (Fremd-Verweis-Schutz).
function _beatBelongs(bookId, userEmail, beatId) {
  const b = _stmtGetBeat.get(parseInt(beatId));
  return !!(b && b.book_id === parseInt(bookId) && b.user_email === userEmail);
}

module.exports = {
  listBeats, getBeat, getBeatMeta, createBeat, updateBeat, deleteBeat, reorderBeats,
  pageBeatCounts, chapterBeatCounts, listFigureIdentities,
  resolveFigureIds, resolveDraftFigureIds, resolveMotifIds, resolveLocationIds,
  _beatBelongs,
};

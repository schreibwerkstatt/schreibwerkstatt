'use strict';
// Motiv-Werkstatt — Soll-Brücken (wo ein Motiv laut Plan trägt) plus die
// Scoping-Validatoren, die Cross-Book-Leaks verhindern. `bridgeRows` liefert dem
// Graph-Payload die fünf Brücken-Lesungen in einem Aufruf.

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');

// ── Soll-Brücken (Figur / Beat / Kapitel / Seite) ──────────────────────────
// Setter sind Full-Replace pro Motiv (Transaktion: alle Links löschen, neu setzen).
// Alle IDs sind bereits INTEGER-FKs (Route hat fig_id → figures.id aufgelöst).

function _makeBridge(table, col) {
  const del = db.prepare(`DELETE FROM ${table} WHERE motif_id = ?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (motif_id, ${col}) VALUES (?, ?)`);
  const set = db.transaction((motifId, ids) => {
    del.run(parseInt(motifId));
    for (const id of ids || []) {
      if (id == null) continue;
      ins.run(parseInt(motifId), parseInt(id));
    }
  });
  return set;
}
const setMotifFigures = _makeBridge('motif_figures', 'figure_id');
const setMotifDraftFigures = _makeBridge('motif_draft_figures', 'draft_figure_id');
const setMotifBeats = _makeBridge('motif_beats', 'beat_id');
const setMotifChapters = _makeBridge('motif_chapters', 'chapter_id');
const setMotifPages = _makeBridge('motif_pages', 'page_id');

// Alle Bridge-Links für die Motive eines Buches am Stück laden → Map motif_id → {…}.
// Anzeige-Label (fig_id/Name/Titel) per JOIN zur Lesezeit (kein Snapshot) — der
// Graph und das Seitenpanel rendern Namen ohne Cross-Store-Lookup. figure: TEXT-
// fig_id nach aussen (Frontend-Identität), plus Name.
const _stmtBridgeFigures = db.prepare(`
  SELECT mf.motif_id, f.fig_id, f.name
    FROM motif_figures mf
    JOIN motifs m ON m.id = mf.motif_id
    JOIN figures f ON f.id = mf.figure_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeDraftFigures = db.prepare(`
  SELECT mdf.motif_id, mdf.draft_figure_id, d.name
    FROM motif_draft_figures mdf
    JOIN motifs m ON m.id = mdf.motif_id
    JOIN draft_figures d ON d.id = mdf.draft_figure_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeBeats = db.prepare(`
  SELECT mb.motif_id, mb.beat_id, b.titel
    FROM motif_beats mb
    JOIN motifs m ON m.id = mb.motif_id
    JOIN plot_beats b ON b.id = mb.beat_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgeChapters = db.prepare(`
  SELECT mc.motif_id, mc.chapter_id, c.chapter_name
    FROM motif_chapters mc
    JOIN motifs m ON m.id = mc.motif_id
    JOIN chapters c ON c.chapter_id = mc.chapter_id
   WHERE m.book_id = ? AND m.user_email = ?
`);
const _stmtBridgePages = db.prepare(`
  SELECT mp.motif_id, mp.page_id, p.page_name
    FROM motif_pages mp
    JOIN motifs m ON m.id = mp.motif_id
    JOIN pages p ON p.page_id = mp.page_id
   WHERE m.book_id = ? AND m.user_email = ?
`);

// ── Scoping-Validatoren (Soll-Link-Targets aufs Buch beschränken) ──────────
// Verhindert Cross-Book-Leaks (FK allein liesse ein Motiv aus Buch A auf eine
// Seite aus Buch B zeigen). Figuren nach aussen als TEXT-fig_id → INTEGER id.
// Der Figuren-Katalog ist pro (Buch, User) skopiert und `fig_id` nur darin
// eindeutig — ohne `user_email` träfe `fig_1` die gleichnamige ID eines anderen
// Katalogs im selben Buch (wortgleich zu db/plot.js#resolveFigureIds).

const _stmtFigByFigId = db.prepare('SELECT id FROM figures WHERE book_id = ? AND user_email = ? AND fig_id = ?');
const _stmtFigById = db.prepare('SELECT id FROM figures WHERE book_id = ? AND user_email = ? AND id = ?');
function resolveFigureIds(bookId, userEmail, figIds) {
  const bid = parseInt(bookId);
  const out = [];
  for (const raw of figIds || []) {
    if (raw == null) continue;
    // Erst als TEXT-fig_id versuchen, dann als INTEGER-id (Frontend schickt fig_id).
    let row = _stmtFigByFigId.get(bid, userEmail, String(raw));
    if (!row && /^\d+$/.test(String(raw))) row = _stmtFigById.get(bid, userEmail, parseInt(raw));
    if (row) out.push(row.id);
  }
  return [...new Set(out)];
}

const _filterStmts = new Map();
function _filterIds(sql, bookId, ids, extra = []) {
  let stmt = _filterStmts.get(sql);
  if (!stmt) { stmt = db.prepare(sql); _filterStmts.set(sql, stmt); }
  const bid = parseInt(bookId);
  const out = [];
  for (const raw of ids || []) {
    if (raw == null || !/^\d+$/.test(String(raw))) continue;
    if (stmt.get(bid, parseInt(raw), ...extra)) out.push(parseInt(raw));
  }
  return [...new Set(out)];
}
function validBeatIds(bookId, userEmail, beatIds) {
  return _filterIds('SELECT 1 FROM plot_beats WHERE book_id = ? AND id = ? AND user_email = ?', bookId, beatIds, [userEmail]);
}
function validDraftFigureIds(bookId, userEmail, draftFigureIds) {
  return _filterIds('SELECT 1 FROM draft_figures WHERE book_id = ? AND id = ? AND user_email = ?', bookId, draftFigureIds, [userEmail]);
}
function validChapterIds(bookId, chapterIds) {
  return _filterIds('SELECT 1 FROM chapters WHERE book_id = ? AND chapter_id = ?', bookId, chapterIds);
}
function validPageIds(bookId, pageIds) {
  return _filterIds('SELECT 1 FROM pages WHERE book_id = ? AND page_id = ?', bookId, pageIds);
}

// ── Rückrichtung: welche Motive hängen an DIESER Figur? ────────────────────
// Das Pendant zu db/plot.js#figurePlotUsage — dieselbe Frage, andere Werkstatt.
// Ohne sie ist die Kante Motiv ↔ Figur einseitig: die Motiv-Werkstatt kennt die
// Figur, die Figuren-Werkstatt weiss nichts von ihren Motiven.
//
// Zwei Quellen wie überall, wo Figuren auftauchen: der Komplettanalyse-Katalog
// (`motif_figures` über die Quell-Figur des Drafts) und die Werkstatt selbst
// (`motif_draft_figures`). Ein importierter Draft erbt damit die Motive, die am
// Katalog-Eintrag hängen — sonst hinge dieselbe Figur je nach Herkunft an zwei
// verschiedenen Motiv-Mengen.
//
// `occurrenceCount` kommt mit, weil ein Motiv OHNE Ist-Belege etwas anderes
// aussagt als eines mit: „geplant" ist nicht „trägt". Unter DEMSELBEN Score-Floor
// wie Graph und Konsistenz (`minScore`, 0 = alle) — sonst nennt die Figuren-
// Werkstatt eine andere Zahl als die Konstellation.
const _stmtMotifsForFigure = db.prepare(`
  SELECT DISTINCT m.id, m.name, COALESCE(m.farbe, t.farbe) AS farbe, m.position,
         (SELECT COUNT(*) FROM motif_occurrences o
           WHERE o.motif_id = m.id AND (o.score IS NULL OR o.score >= ?)) AS occurrenceCount
    FROM motifs m
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE m.book_id = ? AND m.user_email = ?
     AND (
       (? IS NOT NULL AND m.id IN (SELECT motif_id FROM motif_draft_figures WHERE draft_figure_id = ?))
       OR
       (? IS NOT NULL AND m.id IN (SELECT motif_id FROM motif_figures WHERE figure_id = ?))
     )
   ORDER BY m.position, m.id
`);

function figureMotifUsage(bookId, userEmail, { draftFigureId = null, sourceFigureId = null, minScore = 0 } = {}) {
  const dId = draftFigureId != null ? parseInt(draftFigureId) : null;
  const sId = sourceFigureId != null ? parseInt(sourceFigureId) : null;
  if (dId == null && sId == null) return { motifs: [] };
  const floor = Number(minScore) || 0;
  const motifs = _stmtMotifsForFigure.all(floor, parseInt(bookId), userEmail, dId, dId, sId, sId);
  return { motifs };
}

// Mehrere Brücken eines Motivs in EINER Transaktion setzen (PUT /:id/links).
// `sets` = { figures?, draftFigures?, beats?, chapters?, pages? } mit bereits
// validierten INTEGER-IDs; ein fehlender Schlüssel lässt die Brücke unberührt.
// Rückgabe false, wenn das Motiv inzwischen gelöscht ist — dann wird nichts
// geschrieben (kein halber Stand, kein FK-Fehler mittendrin). Die einzelnen
// Setter sind selbst Transaktionen; verschachtelt laufen sie als Savepoints.
const _stmtMotifExistsL = db.prepare('SELECT 1 FROM motifs WHERE id = ?');
const _BRIDGE_SETTERS = {
  figures: setMotifFigures, draftFigures: setMotifDraftFigures, beats: setMotifBeats,
  chapters: setMotifChapters, pages: setMotifPages,
};
const setMotifLinks = db.transaction((motifId, sets) => {
  if (!_stmtMotifExistsL.get(parseInt(motifId))) return false;
  for (const [key, setter] of Object.entries(_BRIDGE_SETTERS)) {
    if (sets[key] !== undefined) setter(motifId, sets[key]);
  }
  return true;
});

// Alle fünf Soll-Brücken eines Buchs in Lesereihenfolge — einziger Konsument ist
// der Graph-Payload (db/motifs/graph.js), der sie auf die Motive verteilt.
function bridgeRows(bookId, userEmail) {
  const bid = parseInt(bookId);
  return {
    figures: _stmtBridgeFigures.all(bid, userEmail),
    draftFigures: _stmtBridgeDraftFigures.all(bid, userEmail),
    beats: _stmtBridgeBeats.all(bid, userEmail),
    chapters: _stmtBridgeChapters.all(bid, userEmail),
    pages: _stmtBridgePages.all(bid, userEmail),
  };
}

module.exports = {
  setMotifFigures, setMotifDraftFigures, setMotifBeats, setMotifChapters, setMotifPages,
  setMotifLinks, resolveFigureIds, validBeatIds, validDraftFigureIds, validChapterIds, validPageIds,
  bridgeRows, figureMotifUsage,
};

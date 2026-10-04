'use strict';
// Plot-Werkstatt-Tool: liefert das geplante Beat-Board (Akte → Beats) als
// kompakten Snapshot. Planendes Pendant zur rueckwaertsgewandten Szenen-Analyse —
// zeigt, was der User VORHAT, nicht was schon im Manuskript steht. Pro Buch + User
// skopiert (kein geteilter Katalog). Read-only, kein KI-Call.

const { listActs, listThreads, listBeats, listBeatRelations } = require('../../../db/plot');
const { listDraftFigures } = require('../../../db/draft-figures');
const { listFigureNamesForUser } = require('../../../db/book-chat/figures');
const { _truncateResult } = require('./shared');

const BEAT_DESC_PREVIEW = 600;
// status = binäre Realisierungsachse (Idee ↔ eingearbeitet); verworfen ist ein
// eigenes Flag, kein Status-Wert.
const BEAT_STATUS = ['geplant', 'im_buch'];

// fig_id (TEXT, Frontend-Identitaet) → Anzeigename, aufs (Buch, User)-Subset
// gescoped — analog zu db/plot.js#resolveFigureIds.
function _figureNameMap(bookId, userEmail) {
  const map = {};
  for (const r of listFigureNamesForUser(bookId, userEmail)) {
    map[r.fig_id] = r.name || r.kurzname || r.fig_id;
  }
  return map;
}

// draft_figures.id (INTEGER) → Name. listDraftFigures ist bereits (Buch, User)-gescoped.
function _draftFigureNameMap(bookId, userEmail) {
  const map = {};
  for (const d of listDraftFigures(bookId, userEmail)) map[d.id] = d.name;
  return map;
}

function tool_get_plot_board(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const acts = listActs(ctx.bookId, userEmail);
  if (!acts.length) {
    return {
      acts: [],
      total_acts: 0,
      total_beats: 0,
      hint: 'Keine Plot-Werkstatt vorhanden. Der User plant die Handlung als Beat-Board (Akte → Beats) ueber die Plot-Karte (tile.plot). Leeres Board ≠ Buch ohne Handlung — es heisst nur, dass der User keine separate Plot-Planung angelegt hat.',
    };
  }

  const statusFilter = BEAT_STATUS.includes(input?.status) ? input.status : null;
  const actFilter = Number.isInteger(input?.act_id) ? input.act_id : null;

  const allBeats = listBeats(ctx.bookId, userEmail);
  // Ausgehende Beat-Kanten (Setup/Payoff, Kausalität) je Quell-Beat — die Ziel-ID
  // bleibt mit, damit das Modell den Payoff auch in einem gefilterten Snapshot findet.
  const relsByBeat = new Map();
  for (const r of listBeatRelations(ctx.bookId, userEmail)) {
    if (!relsByBeat.has(r.from_beat_id)) relsByBeat.set(r.from_beat_id, []);
    relsByBeat.get(r.from_beat_id).push({ typ: r.typ, zu_beat_id: r.to_beat_id, zu: r.to_titel });
  }
  const figNames = _figureNameMap(ctx.bookId, userEmail);
  const draftNames = _draftFigureNameMap(ctx.bookId, userEmail);

  // Handlungsstränge (Swimlanes): Name + gebundene Hauptfigur (Katalog via fig_id,
  // sonst Werkstatt via draft_figure_id). id→Name-Map für die Beat-Annotation.
  const threads = listThreads(ctx.bookId, userEmail);
  const threadNameById = {};
  // Vererbung (live): Beats einer Strang-Lane erben Hauptfigur + Kapitel des Strangs.
  // threadInfoById hält die gebundenen Werte zur Beat-Annotation.
  const threadInfoById = {};
  const threadList = threads.map(t => {
    threadNameById[t.id] = t.name;
    const figur = t.fig_id ? (figNames[t.fig_id] || null)
      : (t.draft_figure_id ? (draftNames[t.draft_figure_id] || null) : null);
    threadInfoById[t.id] = { figur, kapitel: t.chapter_name || null };
    return {
      id: t.id,
      name: t.name,
      figur,
      ...(t.chapter_name ? { kapitel: t.chapter_name } : {}),
    };
  });

  // Statusverteilung ueber das GANZE Board (vor Filter) — gibt dem Modell die
  // Gesamtsicht „wie viel geplant vs. schon im Buch". verworfen ist eine eigene
  // Achse (Flag) und wird separat gezaehlt (unabhaengig vom Status).
  const statusCounts = { geplant: 0, im_buch: 0, verworfen: 0 };
  for (const b of allBeats) {
    if (b.verworfen) statusCounts.verworfen++;
    if (statusCounts[b.status] != null) statusCounts[b.status]++;
  }

  const beatsByAct = new Map();
  for (const b of allBeats) {
    if (statusFilter && b.status !== statusFilter) continue;
    if (!beatsByAct.has(b.act_id)) beatsByAct.set(b.act_id, []);
    const tInfo = b.thread_id != null ? threadInfoById[b.thread_id] : null;
    const figures = (b.fig_ids || []).map(fid => figNames[fid] || fid);
    // Implizit vom Strang geerbt: Hauptfigur (falls nicht schon explizit) + Kapitel
    // (nur wenn der Beat kein eigenes hat). Faktisch wirksam, daher exponiert.
    const geerbteFigur = tInfo && tInfo.figur && !figures.includes(tInfo.figur) ? tInfo.figur : null;
    const geerbtesKapitel = !b.chapter_name && tInfo && tInfo.kapitel ? tInfo.kapitel : null;
    beatsByAct.get(b.act_id).push({
      id: b.id,
      titel: b.titel,
      beschreibung: b.beschreibung && b.beschreibung.length > BEAT_DESC_PREVIEW
        ? b.beschreibung.slice(0, BEAT_DESC_PREVIEW) + '…'
        : (b.beschreibung || null),
      status: b.status,
      ...(b.verworfen ? { verworfen: true } : {}),
      ...(b.intensitaet != null ? { intensitaet: b.intensitaet } : {}),
      ...(b.zeit ? { zeit: b.zeit } : {}),
      chapter_id: b.chapter_id || null,
      chapter_name: b.chapter_name || null,
      thread: b.thread_id != null ? (threadNameById[b.thread_id] || null) : null,
      figures,
      werkstatt_figures: (b.draft_fig_ids || []).map(did => draftNames[did]).filter(Boolean),
      ...((b.locations || []).length ? { orte: b.locations.map(l => l.name).filter(Boolean) } : {}),
      ...((b.motifs || []).length ? { motive: b.motifs.map(m => m.name).filter(Boolean) } : {}),
      ...(relsByBeat.has(b.id) ? { beziehungen: relsByBeat.get(b.id) } : {}),
      ...(geerbteFigur ? { geerbte_figur: geerbteFigur } : {}),
      ...(geerbtesKapitel ? { geerbtes_kapitel: geerbtesKapitel } : {}),
    });
  }

  const actList = acts
    .filter(a => actFilter == null || a.id === actFilter)
    .map(a => {
      const beats = beatsByAct.get(a.id) || [];
      return {
        id: a.id,
        name: a.name,
        ...(a.farbe ? { farbe: a.farbe } : {}),
        // Hybrid-Akte: ein Akt ist GETEILT (alle Stränge) oder gehört EINEM Strang.
        ...(a.thread_id != null ? { eigener_akt_von_strang: threadNameById[a.thread_id] || null } : {}),
        beat_count: beats.length,
        beats,
      };
    });

  return _truncateResult({
    acts: actList,
    total_acts: acts.length,
    total_beats: allBeats.length,
    ...(threadList.length ? { threads: threadList } : {}),
    status_counts: statusCounts,
    ...(statusFilter ? { status_filter: statusFilter } : {}),
    status_legende: 'status = geplant (Idee, noch nicht geschrieben) oder im_buch (im Manuskript umgesetzt). verworfen ist ein separates Flag (true = ausgemustert, soll nicht mehr ins Buch) — unabhaengig vom status.',
    felder_legende: 'Optionale Beat-Felder: intensitaet = geplante Spannung 1–5 (Spannungsbogen); zeit = WANN der Beat in der erzählten Welt spielt (Freitext); orte = Schauplätze; motive = verknüpfte Motive der Motiv-Werkstatt; beziehungen = ausgehende Kanten zu anderen Beats (typ bereitet-vor/zahlt-ein = Setup/Payoff, fuehrt-zu/motiviert/blockiert/spiegelt = Kausalität; zu_beat_id = Ziel-Beat).',
    ...(threadList.length ? { strang_hinweis: 'threads = parallele Erzähllinien (Swimlanes), oft je Hauptfigur, optional mit gebundenem Kapitel. Jeder Beat trägt sein thread-Feld (Strang-Name oder null = ohne Strang). Beats erben die Hauptfigur (geerbte_figur) und — ohne eigenes Kapitel — das Kapitel (geerbtes_kapitel) ihres Strangs implizit. Akte ohne eigener_akt_von_strang sind GETEILT (gelten für alle Stränge); ein Akt mit eigener_akt_von_strang gehört nur diesem Strang (Hybrid — dieser Strang plant mit einer eigenen Aktstruktur).' } : {}),
  });
}

module.exports = {
  tool_get_plot_board,
};

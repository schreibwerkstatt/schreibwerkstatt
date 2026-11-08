// Plan-Slice der Referenz-Karte (Alpine.data('referenceCard'), cards/reference-card.js):
// die Beats des Beat-Boards neben dem Notebook-Editor — was im offenen Kapitel
// laut Plan passieren soll, waehrend man es schreibt.
//
// Warum im Referenz-Slot und nicht als eigene Karte: der Plan gehoert an den
// Schreibort. Das Board ist eine Buchkarte und schliesst den Editor
// (Exklusivitaet); hier steht er daneben, read-only. Pflege bleibt im Board —
// jede Zeile springt per Beat-Permalink (#book/<id>/plot/<beatId>) dorthin.
//
// Kontext-Regel wie bei den Geschwister-Reitern (reference-context.js): ein Beat
// haengt an einem KAPITEL (`plot_beats.chapter_id`, sonst geerbt vom Strang),
// nie an einer Seite. Die
// Seiten-Zugehoerigkeit kommt deshalb nicht aus dem Plan, sondern aus der
// Beat-Verankerung (`occ_top[].page_id`, mitgeliefert vom Board-GET): 'page' =
// der Beat wurde auf der offenen Seite im Text gefunden, 'chapter' = er gehoert
// ins Kapitel, steht aber (noch) nicht hier. Markiert wird wie bei den
// Geschwister-Reitern nur 'chapter' («im Kapitel»).
//
// Daten: GET /plot/?book_id — derselbe Payload wie das Board (Akte, Straenge,
// Beats mit fig_ids/locations/motifs/occ_top). Pro Buch + User skopiert, wie
// das Board selbst. Schreibt nie.

import { fetchJson } from '../utils.js';
import { beatReadingOrder } from '../book/plot/constants.js';
import { figurAnzeigeName } from '../book/figur-name.js';

/** Aktiv = nicht verworfen (Spalte `verworfen` ODER Alt-Status 'verworfen'). */
const isActive = (b) => !b?.verworfen && b?.status !== 'verworfen';

/** Aktive Beats in Board-Lesereihenfolge — Lane für Lane (Stränge nach position,
 *  „ohne Strang" zuletzt), je Lane deren Akte (strang-eigene, sonst geteilte,
 *  nach position), dann sort_order. Regel-SSoT: plot/constants.js#beatReadingOrder.
 *  Eine globale Akt-position-Sortierung mischte geteilte und strang-eigene
 *  Positionen (zwei unabhängige 0..n-Sequenzen). Pure. */
export function orderPlanBeats(plan) {
  return beatReadingOrder({
    acts: plan?.acts || [],
    threads: plan?.threads || [],
    beats: (plan?.beats || []).filter(isActive),
  });
}

/** Kapitel eines Beats: das eigene, sonst das seines Strangs — Beats der
 *  Strang-Lane erben es implizit (Buch-Chat: `geerbtes_kapitel`). */
function effectiveChapterId(beat, threadChapter) {
  if (beat.chapter_id != null) return beat.chapter_id;
  return beat.thread_id != null ? (threadChapter.get(beat.thread_id) ?? null) : null;
}

/** Kontext-Auswahl: Beats des Kapitels, auf der Seite verankerte zuerst. Pure. */
export function selectPlanBeatsForPage(ordered, { pageId, chapterId, threads = [] }) {
  if (chapterId == null) return [];
  const threadChapter = new Map((threads || []).map(t => [t.id, t.chapter_id ?? null]));
  const onPage = [];
  const inChapter = [];
  for (const b of ordered) {
    const cid = effectiveChapterId(b, threadChapter);
    if (cid == null || Number(cid) !== Number(chapterId)) continue;
    const here = pageId != null && (b.occ_top || []).some(o => o?.page_id != null && Number(o.page_id) === Number(pageId));
    (here ? onPage : inChapter).push(b);
  }
  return [
    ...onPage.map(b => ({ ...b, refCtx: 'page' })),
    ...inChapter.map(b => ({ ...b, refCtx: 'chapter' })),
  ];
}

/** Besetzung eines Beats als Namensliste (dedupliziert, Reihenfolge: Katalog-
 *  Figuren, Werkstatt-Figuren, geerbte Strang-Hauptfigur, Orte). Katalog-
 *  Identitaet ist die TEXT-fig_id (nie durch Number() schicken), Werkstatt die
 *  INTEGER draft_figures.id. Pure. */
export function planCastNames(beat, { figuren = [], draftFigures = [], threads = [] } = {}) {
  if (!beat) return [];
  const figById = new Map((figuren || []).map(f => [String(f.id), f]));
  const draftById = new Map((draftFigures || []).map(d => [String(d.id), d]));
  const figName = (id) => { const f = figById.get(String(id)); return f ? figurAnzeigeName(f) : null; };
  const draftName = (id) => draftById.get(String(id))?.name || null;
  const names = [
    ...(beat.fig_ids || []).map(figName),
    ...(beat.draft_fig_ids || []).map(draftName),
  ];
  const t = beat.thread_id != null ? (threads || []).find(x => x.id === beat.thread_id) : null;
  if (t?.fig_id) names.push(figName(t.fig_id));
  else if (t?.draft_figure_id != null) names.push(draftName(t.draft_figure_id));
  const orte = (beat.locations || []).map(l => l?.name);
  return [...new Set([...names, ...orte].filter(Boolean))];
}

export function referencePlanState() {
  return {
    referencePlan: null,              // { acts, threads, beats } aus GET /plot/
    referencePlanLoading: false,
    referencePlanError: '',
  };
}

export const referencePlanMethods = {
  // Buchwechsel-Race: nach jedem await prüfen, ob das Buch noch dasselbe ist
  // (`_staleBook` der Karte). Werkstatt-Figuren (für die Besetzungszeile)
  // best-effort dazu, im Plan-Objekt abgelegt — so räumt der Reset von
  // referencePlan sie mit ab.
  async _loadReferencePlan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.referencePlan = null; return; }
    const stale = () => this._staleBook(bookId);
    this.referencePlanLoading = true;
    this.referencePlanError = '';
    try {
      const r = await fetchJson(`/plot/?book_id=${encodeURIComponent(bookId)}`);
      if (stale()) return;
      if (!r || !Array.isArray(r.beats)) { this.referencePlan = null; return; }
      let draftFigures = [];
      try {
        const d = await fetchJson(`/draft-figures/${encodeURIComponent(bookId)}`);
        draftFigures = Array.isArray(d) ? d.map(x => ({ id: x.id, name: x.name })) : [];
      } catch { draftFigures = []; }
      if (stale()) return;
      this.referencePlan = { ...r, draftFigures };
    } catch {
      if (stale()) return;
      this.referencePlan = null;
      this.referencePlanError = window.__app.t('reference.plan.loadError');
    } finally {
      if (!stale()) {
        this.referencePlanLoading = false;
        this._ensureVisibleTab();
      }
    }
  },

  _planOrdered() {
    return this._memo('planOrdered', [this.referencePlan], () => orderPlanBeats(this.referencePlan));
  },

  // Tab-Sichtbarkeit: ohne aktiven Beat im Buch gibt es keinen Plan zu zeigen
  // (analog Quellen-Tab ohne Quellen). Ein Ladefehler zeigt den Reiter, damit
  // die Meldung nicht mit ihm verschwindet.
  referenceHasPlan() { return this._planOrdered().length > 0 || !!this.referencePlanError; },

  referencePlanBeats() {
    const app = window.__app;
    const pid = app?.currentPage?.id ?? null;
    const cid = app?.currentPage?.chapter_id ?? null;
    const ordered = this._planOrdered();
    const threads = this.referencePlan?.threads || [];
    return this._memo('plan', [this.referenceScope, pid, cid, ordered, threads], () => {
      if (!this._contextActive()) return ordered;
      return selectPlanBeatsForPage(ordered, { pageId: pid, chapterId: cid, threads });
    });
  },

  /** Akt · Strang · Zeit — woran man den Beat auf dem Board wiederfindet. */
  referencePlanMeta(beat) {
    const plan = this.referencePlan || {};
    const act = (plan.acts || []).find(a => a.id === beat?.act_id);
    const thread = beat?.thread_id != null ? (plan.threads || []).find(t => t.id === beat.thread_id) : null;
    return [act?.name, thread?.name, beat?.zeit].filter(Boolean).join(' · ');
  },

  /** Beteiligte Figuren + Orte als eine Zeile: Katalog-Figuren, Werkstatt-
   *  Figuren und die vom Strang geerbte Hauptfigur (Live-Vererbung, nie am Beat
   *  gespeichert), dann Orte. Pure Rechnung in planCastNames. */
  referencePlanCast(beat) {
    return planCastNames(beat, {
      figuren: Alpine.store('catalog').figuren || [],
      draftFigures: this.referencePlan?.draftFigures || [],
      threads: this.referencePlan?.threads || [],
    }).join(', ');
  },

  referencePlanMotifs(beat) {
    return (beat?.motifs || []).map(m => m?.name).filter(Boolean).join(', ');
  },

  referencePlanStatus(beat) {
    return beat?.status ? window.__app.t('plot.status.' + beat.status) : '';
  },

  /** Sprung aufs Board, Beat fokussiert (Hash-Router: case 'plot' + Permalink). */
  openReferenceBeat(beat) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || beat?.id == null) return;
    location.hash = `#book/${bookId}/plot/${beat.id}`;
  },
};

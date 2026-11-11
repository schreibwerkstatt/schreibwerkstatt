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

/** Nachschlage-Maps für planCastRefs — einmal je Katalog-/Plan-Stand bauen,
 *  nicht je Beat und Render. Pure. */
export function planCastLookup({ figuren = [], draftFigures = [], threads = [] } = {}) {
  return {
    figById: new Map((figuren || []).map(f => [String(f.id), f])),
    draftById: new Map((draftFigures || []).map(d => [String(d.id), d])),
    threadById: new Map((threads || []).map(t => [t.id, t])),
  };
}

/** Besetzung eines Beats als Entitäts-Referenz-Specs (entity-ref.js), dedupliziert;
 *  Reihenfolge: Katalog-Figuren, Werkstatt-Figuren, geerbte Strang-Hauptfigur
 *  (`inherited: true` — Live-Vererbung, nie am Beat gespeichert), Orte.
 *  Katalog-Identitaet ist die TEXT-fig_id (nie durch Number() schicken),
 *  Werkstatt die INTEGER draft_figures.id. Figuren, die der Katalog (noch)
 *  nicht kennt, fallen weg statt als «#fig_…» zu stehen; Werkstatt-Figuren und
 *  Orte tragen ihr Label selbst (kein Frontend-Katalog bzw. Name am Beat). Pure. */
export function planCastRefs(beat, lookup) {
  if (!beat) return [];
  const { figById, draftById, threadById } = lookup || planCastLookup();
  const out = [];
  const seen = new Set();
  const push = (spec) => {
    const k = spec.type + ':' + String(spec.id);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(spec);
  };
  const fig = (id, extra) => { if (figById.has(String(id))) push({ type: 'figur', id, ...extra }); };
  const draft = (id, extra) => {
    const name = draftById.get(String(id))?.name;
    if (name) push({ type: 'werkstatt', id, label: name, ...extra });
  };
  for (const id of beat.fig_ids || []) fig(id);
  for (const id of beat.draft_fig_ids || []) draft(id);
  const t = beat.thread_id != null ? threadById.get(beat.thread_id) : null;
  if (t?.fig_id) fig(t.fig_id, { inherited: true });
  else if (t?.draft_figure_id != null) draft(t.draft_figure_id, { inherited: true });
  for (const l of beat.locations || []) {
    if (l?.id != null) push({ type: 'ort', id: l.id, label: l.name });
  }
  return out;
}

/** Motive eines Beats als Referenz-Specs (Motiv-Werkstatt hat keinen
 *  Frontend-Katalog → Label vom Beat). Pure. */
export function planMotifRefs(beat) {
  return (beat?.motifs || [])
    .filter(m => m?.id != null)
    .map(m => ({ type: 'motiv', id: m.id, label: m.name }));
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
  // referencePlan sie mit ab. Beide Anfragen laufen gleichzeitig; ein Fehler
  // der Werkstatt-Figuren kostet nur deren Namen in der Besetzung.
  async _loadReferencePlan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.referencePlan = null; return; }
    const stale = () => this._staleBook(bookId);
    this.referencePlanLoading = true;
    this.referencePlanError = '';
    try {
      const draftsP = fetchJson(`/draft-figures/${encodeURIComponent(bookId)}`)
        .then(d => (Array.isArray(d) ? d.map(x => ({ id: x.id, name: x.name })) : []))
        .catch(() => []);
      const [r, draftFigures] = await Promise.all([
        fetchJson(`/plot/?book_id=${encodeURIComponent(bookId)}`),
        draftsP,
      ]);
      if (stale()) return;
      if (!r || !Array.isArray(r.beats)) { this.referencePlan = null; return; }
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

  /** Beteiligte Figuren, Werkstatt-Figuren, geerbte Strang-Hauptfigur und Orte
   *  als Entitäts-Referenzen — jede springt zu ihrem Objekt. Pure Rechnung in
   *  planCastRefs; die Maps werden je Katalog-/Plan-Stand einmal gebaut. */
  referencePlanCast(beat) {
    const figuren = Alpine.store('catalog').figuren || [];
    const plan = this.referencePlan;
    const lookup = this._memo('planCastLookup', [figuren, plan], () => planCastLookup({
      figuren, draftFigures: plan?.draftFigures || [], threads: plan?.threads || [],
    }));
    const inheritedTitle = window.__app.t('plot.beat.inheritedFigure');
    return planCastRefs(beat, lookup)
      .map(r => (r.inherited ? { ...r, title: inheritedTitle } : r));
  },

  referencePlanMotifs(beat) { return planMotifRefs(beat); },

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

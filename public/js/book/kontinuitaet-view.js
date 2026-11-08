// Ansicht + Filter der Kontinuitäts-Befundliste (gespreadet in kontinuitaetMethods).
//
// Zwei Achsen, zwei Speicher (beide pro Konto UND Buch, FILTER_SCOPES in
// app-view/_shared.js, Host `Alpine.store('catalogUi')`):
//  - Ansicht (`kontinuitaetView`, Menü «Ansicht»): WELCHE Triage-Stände die Liste
//    überhaupt führt — Erledigte ausblenden, «Kein Fehler» und von der Prüfung
//    Verworfene einblenden. Eine Arbeitsgewohnheit, die ein «Filter zurücksetzen»
//    nicht anfasst.
//  - Filter (`kontinuitaetFilters`): Suche, Schwere, Figur, Kapitel und der Fokus
//    «Nicht mehr gemeldet» (`fokus: 'missing'`) — eingrenzen innerhalb der Ansicht.
//    Der Fokus übersteuert die Ansicht: er zeigt genau die offenen, nicht mehr
//    gemeldeten Befunde, gleich welche Schalter stehen.
//
// Ausgeblendete Stände zählen in keinem Schwere-Reiter: „Kritisch 3" meint drei
// sichtbare Zeilen.

import { activeFilterId } from '../chapter-filter.js';

export const KONTINUITAET_FILTER_DEFAULTS = Object.freeze({ figurId: '', kapitelId: '', schwere: '', fokus: '', suche: '' });
export const KONTINUITAET_VIEW_DEFAULTS = Object.freeze({ hideResolved: true, showDismissed: false, showDiscarded: false });

// Schwere eines Befunds, normalisiert: fehlend/unbekannt = niedrig. SSoT für
// Filter, Sortierung, Tab-Zähler und Tag — sonst zählt ein Tab andere Zeilen,
// als sein Filter zeigt.
export const KONTINUITAET_SEVERITIES = ['kritisch', 'mittel', 'niedrig'];
export function kontinuitaetSeverity(issue) {
  const s = issue?.schwere;
  return KONTINUITAET_SEVERITIES.includes(s) ? s : 'niedrig';
}

function _view() {
  return { ...KONTINUITAET_VIEW_DEFAULTS, ...(Alpine.store('catalogUi').kontinuitaetView || {}) };
}

// Führt die Liste diesen Befund? `fokus === 'missing'` übersteuert die Ansicht.
export function kontinuitaetVisible(issue, view, fokus) {
  if (fokus === 'missing') return !issue.discarded && !issue.dismissed && !issue.resolved && !!issue.missing_since;
  if (issue.discarded) return !!view.showDiscarded;
  if (issue.dismissed) return !!view.showDismissed;
  if (issue.resolved) return !view.hideResolved;
  return true;
}

// Triage-Rang für die Sortierung: offen vor erledigt vor «kein Fehler» vor verworfen.
function _triageRank(issue) {
  if (issue.discarded) return 3;
  if (issue.dismissed) return 2;
  if (issue.resolved) return 1;
  return 0;
}

const SEVERITY_ORDER = { kritisch: 0, mittel: 1, niedrig: 2 };

export const kontinuitaetViewMethods = {
  // Befunde des Checks insgesamt (geführte + verworfene) — für Filterleiste und Leer-Zustände.
  kontinuitaetAllIssues() {
    const r = this.kontinuitaetResult;
    return [...(r?.issues || []), ...(r?.discarded || [])];
  },

  kontinuitaetDiscardedCount() { return (this.kontinuitaetResult?.discarded || []).length; },
  kontinuitaetResolvedCount() {
    return (this.kontinuitaetResult?.issues || []).filter(i => i.resolved && !i.dismissed).length;
  },
  kontinuitaetDismissedCount() {
    return (this.kontinuitaetResult?.issues || []).filter(i => i.dismissed).length;
  },

  // Befunde, die Ansicht + Fokus führen — Basis der Schwere-Zähler und des
  // Leerzustands „alles ausgeblendet". Memoisiert (pro Render mehrfach gelesen).
  kontinuitaetIssuesVisible() {
    const ui = Alpine.store('catalogUi');
    const view = _view();
    const fokus = ui.kontinuitaetFilters.fokus || '';
    const all = this.kontinuitaetAllIssues();
    return this._memo('visible',
      [this.kontinuitaetResult, view.hideResolved, view.showDismissed, view.showDiscarded, fokus],
      () => all.filter(i => kontinuitaetVisible(i, view, fokus)));
  },

  // Befunde, die die Ansicht gerade verbirgt (Verworfene zählen nicht mit: sie
  // sind kein Befund des Autors, sondern Aussortiertes der Prüfung).
  kontinuitaetHiddenCount() {
    const view = _view();
    return (view.hideResolved ? this.kontinuitaetResolvedCount() : 0)
      + (view.showDismissed ? 0 : this.kontinuitaetDismissedCount());
  },

  // Ansichts-Menü der Filterleiste (view-menu.html, Vertrag in public/js/view-menu.js).
  // Einblend-Schalter ohne Befunde dahinter fehlen — sie zählen dann auch nicht
  // am Knopf. «Erledigte ausblenden» ist von Haus aus an (`base: true`).
  viewMenuSpec() {
    const t = (k, p) => window.__app.t(k, p);
    const view = _view();
    const items = [
      { kind: 'toggle', key: 'hideResolved', base: KONTINUITAET_VIEW_DEFAULTS.hideResolved, on: view.hideResolved,
        label: t('kontinuitaet.view.hideResolved', { n: this.kontinuitaetResolvedCount() }),
        toggle: () => this.kontinuitaetToggleView('hideResolved') },
    ];
    const dismissed = this.kontinuitaetDismissedCount();
    if (dismissed > 0) {
      items.push({ kind: 'toggle', key: 'showDismissed', on: view.showDismissed,
        label: t('kontinuitaet.view.showDismissed', { n: dismissed }),
        toggle: () => this.kontinuitaetToggleView('showDismissed') });
    }
    const discarded = this.kontinuitaetDiscardedCount();
    if (discarded > 0) {
      items.push({ kind: 'toggle', key: 'showDiscarded', on: view.showDiscarded,
        label: t('kontinuitaet.view.showDiscarded', { n: discarded }), tip: t('kontinuitaet.discard.hint'),
        toggle: () => this.kontinuitaetToggleView('showDiscarded') });
    }
    return { tip: t('kontinuitaet.view.tip'), items };
  },

  // In place (wie filter-persist.js#applyFilterScope): Template-Bindings und der
  // Persist-Watcher halten dieselbe Objekt-Referenz.
  kontinuitaetToggleView(key) {
    const v = Alpine.store('catalogUi').kontinuitaetView;
    v[key] = !_view()[key];
  },

  // Leerzustand „alles ausgeblendet": Erledigte und «Kein Fehler» wieder zeigen.
  kontinuitaetShowHidden() {
    Object.assign(Alpine.store('catalogUi').kontinuitaetView, { hideResolved: false, showDismissed: true });
  },

  kontinuitaetToggleFokusMissing() {
    const f = Alpine.store('catalogUi').kontinuitaetFilters;
    f.fokus = f.fokus === 'missing' ? '' : 'missing';
  },

  // Alle Filter auf ihre Defaults (Zustand „Alle weggefiltert"); die Ansicht bleibt.
  kontinuitaetResetFilters() {
    Object.assign(Alpine.store('catalogUi').kontinuitaetFilters, KONTINUITAET_FILTER_DEFAULTS);
  },

  // Sichtbare Befunde, gefiltert nach Suche/Figur/Kapitel/Schwere. Muss eine Methode
  // sein (keine `get`-Syntax): die Methods werden per `...spread` in die
  // Alpine.data-Factory übernommen, und Spread ruft Getter auf und speichert nur
  // den Wert — die Reaktivität auf Filter/Result ginge verloren.
  kontinuitaetIssuesFiltered() {
    const filters = Alpine.store('catalogUi').kontinuitaetFilters;
    const visible = this.kontinuitaetIssuesVisible();
    const chapters = this._kontinuitaetChapters();
    const figuren = window.__app.$store.catalog.figuren || [];
    const pages = Alpine.store('nav').pages || [];
    const kapitelId = filters.kapitelId ? activeFilterId(filters.kapitelId, this.kontinuitaetKapitelOptionen()) : '';
    return this._memo(
      'filtered',
      [visible, chapters, pages, figuren, filters.figurId, kapitelId, filters.schwere, filters.suche],
      () => this._computeKontinuitaetIssuesFiltered(visible, chapters, figuren, { ...filters, kapitelId }),
    );
  },

  _computeKontinuitaetIssuesFiltered(issues, chapters, figuren, filters) {
    const chapterOf = this._kontinuitaetChapterResolver(chapters);
    const q = (filters.suche || '').trim().toLowerCase();
    return issues.filter(issue => {
      if (filters.figurId) {
        if (issue.fig_ids?.length) {
          if (!issue.fig_ids.includes(filters.figurId)) return false;
        } else {
          const selectedName = figuren.find(f => f.id === filters.figurId)?.name || '';
          if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
        }
      }
      if (filters.kapitelId && !chapterOf(issue).has(String(filters.kapitelId))) return false;
      if (filters.schwere && kontinuitaetSeverity(issue) !== filters.schwere) return false;
      if (q && !this._kontinuitaetSearchText(issue).includes(q)) return false;
      return true;
    });
  },

  // Memoisiert auf die (ihrerseits memoisierte) gefilterte Liste: das Template
  // liest sie mehrmals pro Render (Zaehler, Leer-Zustand, x-for).
  kontinuitaetIssuesSorted() {
    const filtered = this.kontinuitaetIssuesFiltered();
    return this._memo('sorted', [filtered], () => this._sortKontinuitaetIssues(filtered));
  },

  // Offene zuerst, dann erledigt, «kein Fehler», verworfen; je Stand nach Schwere.
  _sortKontinuitaetIssues(filtered) {
    return filtered.slice().sort((a, b) =>
      (_triageRank(a) - _triageRank(b))
      || (SEVERITY_ORDER[kontinuitaetSeverity(a)] - SEVERITY_ORDER[kontinuitaetSeverity(b)]));
  },

  // Triage-Wechsel in place: Sichtbarkeit, Filter, Sortierung und Zähler neu berechnen.
  _invalidateKontinuitaetSort() {
    if (this._memos) {
      delete this._memos.visible; delete this._memos.sorted;
      delete this._memos.filtered; delete this._memos.counts;
    }
  },

  // Tab-Zähler { all, kritisch, mittel, niedrig } über die sichtbaren Befunde,
  // mit derselben Schwere-Normalisierung wie der Filter.
  kontinuitaetSeverityCounts() {
    const visible = this.kontinuitaetIssuesVisible();
    return this._memo('counts', [visible], () => {
      const counts = { all: 0, kritisch: 0, mittel: 0, niedrig: 0 };
      for (const i of visible) {
        counts.all++;
        counts[kontinuitaetSeverity(i)]++;
      }
      return counts;
    });
  },
};

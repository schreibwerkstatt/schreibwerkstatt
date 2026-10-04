// Alpine.data('szenenCard') — Sub-Komponente der Szenen-Karte.
//
// Eigener State: Lade-Flag, Fehlerzeile, Ansicht (Liste/Grid).
// Geteilt:
//   - `szenen` (Alpine.store('catalog'))
//   - `szenenFilters`/`selectedSzeneId`/`szenenUpdatedAt` (Alpine.store('catalogUi'))
// Root behält nur `loadSzenen` (von komplett-Job, Orte, Palette, Kapitel-Dashboard
// u.a. gerufen). Sortierung, Verteilungen und Filter-Optionen sind reine
// Funktionen in ../book/szenen-stats.js; hier werden sie nur an die
// Buchreihenfolge des Roots gebunden.
import { setupCardLifecycle } from './card-lifecycle.js';
import { memoMethods } from './card-memo.js';
import {
  applySzenenFilters, sortSzenen, szenenGridRows, szenenNachKapitel, szenenNachSeite,
  szenenNachFigur, szenenWertungCounts, szenenKapitelOptionen, szenenSeitenOptionen,
  buildKapitelLabels, wertungOf,
} from '../book/szenen-stats.js';
import { lsGet, lsSet } from '../safe-storage.js';
import { plotBacklinkMethods } from '../book/plot-backlinks.js';

export function registerSzenenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('szenenCard', () => ({
    szenenLoading: false,
    szenenError: '',
    staleDeleting: false,
    viewMode: lsGet('szenen.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid'
    _lifecycle: null,
    _memos: {},
    // Map Szenen-id → Beats, deren Verankerung diese Szene trifft (Detail „Im Plot“).
    plotBacklinks: {},
    ...memoMethods,
    ...plotBacklinkMethods,

    get _filters() { return Alpine.store('catalogUi').szenenFilters; },
    get _szenen() { return Alpine.store('catalog').szenen; },

    // Buchposition einer Szene: Kapitel/Seite über die ID (gleichnamige Kapitel
    // bleiben getrennt), Name nur als Fallback für verwaiste Referenzen.
    _order() {
      const root = window.__app;
      return {
        chapterIdx: (s) => {
          const i = s.chapter_id != null ? root._chapterIdIdx(s.chapter_id) : 9999;
          return i !== 9999 ? i : root._chapterIdx(s.kapitel);
        },
        pageIdx: (s) => (s.page_id != null ? root._pageIdIdx(s.page_id) : root._pageIdx(s.seite)),
      };
    },
    // Memo-Deps: Szenen-Array + Sortier-Indexe des Baums (werden bei jedem
    // Baum-Umbau neu zugewiesen) + Kapitel-Labels.
    _baseDeps() {
      const root = window.__app;
      return [this._szenen, root._chapterIdOrderMap, root._chapterOrderMap,
        root._pageIdOrderMap, root._pageOrderMap, this._kapitelLabels()];
    },
    _filterDeps() {
      const f = this._filters;
      return [f.suche, f.wertung, f.figurId, f.kapitelId, f.seiteId, f.ortId];
    },

    _kapitelLabels() {
      const tree = Alpine.store('nav').tree;
      return this._memo('labels', [tree], () => buildKapitelLabels(tree));
    },
    kapitelLabel(chapterId, fallback) {
      return (chapterId != null && this._kapitelLabels().get(chapterId)) || fallback || '';
    },
    _labelOf() { return (id, n) => this.kapitelLabel(id, n); },

    wertungOf,

    get szenenFiltered() {
      return this._memo('filtered', [...this._baseDeps(), ...this._filterDeps()],
        () => sortSzenen(applySzenenFilters(this._szenen, this._filters), this._order(), this._szenen));
    },
    get gridRows() {
      const list = this.szenenFiltered;
      return this._memo('grid', [list], () => szenenGridRows(list, this._order()));
    },

    get nachKapitel() { return this._memo('nachKapitel', this._baseDeps(), () => szenenNachKapitel(this._szenen, this._order(), this._labelOf())); },
    get nachSeite() { return this._memo('nachSeite', this._baseDeps(), () => szenenNachSeite(this._szenen, this._order(), this._labelOf())); },
    get nachFigur() {
      const figuren = Alpine.store('catalog').figuren;
      return this._memo('nachFigur', [this._szenen, figuren], () => szenenNachFigur(this._szenen, figuren));
    },
    get wertungCounts() { return this._memo('wertung', [this._szenen], () => szenenWertungCounts(this._szenen)); },
    get activeCount() { return this._memo('active', [this._szenen], () => this._szenen.filter(s => !s.stale).length); },
    get staleCount() { return this._szenen.length - this.activeCount; },

    get kapitelOptionen() { return this._memo('kapOpt', this._baseDeps(), () => szenenKapitelOptionen(this._szenen, this._order(), this._labelOf())); },
    get seitenOptionen() {
      const kapitelId = this._filters.kapitelId;
      return this._memo('seiteOpt', [...this._baseDeps(), kapitelId], () => szenenSeitenOptionen(this._szenen, kapitelId, this._order()));
    },

    get updatedLabel() {
      const at = Alpine.store('catalogUi').szenenUpdatedAt;
      return at ? window.__app.formatLastRun(at) : Alpine.store('jobs').alleAktualisierenLastRun;
    },

    // Klicks in der Verteilung setzen den passenden Filter (erneuter Klick hebt ihn auf).
    isFigurFilter(id) { return this._filters.figurId === id; },
    toggleFigurFilter(id) { this._filters.figurId = this.isFigurFilter(id) ? '' : id; },
    isKapitelFilter(row) { return row.chapterId != null && String(this._filters.kapitelId) === String(row.chapterId) && !this._filters.seiteId; },
    toggleKapitelFilter(row) {
      if (row.chapterId == null) return;
      const on = this.isKapitelFilter(row);
      this._filters.kapitelId = on ? '' : row.chapterId;
      this._filters.seiteId = '';
    },
    isSeiteFilter(row) { return row.pageId != null && String(this._filters.seiteId) === String(row.pageId); },
    toggleSeiteFilter(row) {
      if (row.pageId == null || row.chapterId == null) return;
      if (this.isSeiteFilter(row)) { this._filters.seiteId = ''; return; }
      this._filters.kapitelId = row.chapterId;
      this._filters.seiteId = row.pageId;
    },

    // Einzelne Stale-Szene löschen. Nur für stale-Einträge (Server prüft ebenfalls).
    // CASCADE räumt scene_figures/scene_locations + research_item_links mit.
    async deleteStale(s) {
      if (!s?.stale) return;
      const app = window.__app;
      if (!await app.appConfirm({
        message: app.t('szenen.confirmDeleteStale', { name: s.titel }),
        confirmLabel: app.t('common.delete'), danger: true,
      })) return;
      this.szenenError = '';
      try {
        const r = await fetch(`/figures/scenes/${Alpine.store('nav').selectedBookId}/${s.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        Alpine.store('catalog').szenen = this._szenen.filter(x => x.id !== s.id);
      } catch (e) {
        console.error('[szenen.deleteStale]', e);
        this.szenenError = app.t('szenen.deleteFailed');
      }
    },

    // Alle Stale-Szenen des Buchs auf einmal (gleicher Endpunkt wie die Danger-Zone).
    async deleteAllStale() {
      const n = this.staleCount;
      if (!n || this.staleDeleting) return;
      const app = window.__app;
      if (!await app.appConfirm({
        message: app.t('szenen.confirmDeleteAllStale', { n }),
        confirmLabel: app.t('common.delete'), danger: true,
      })) return;
      this.staleDeleting = true;
      this.szenenError = '';
      try {
        const r = await fetch(`/figures/scenes/${Alpine.store('nav').selectedBookId}/stale`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        Alpine.store('catalog').szenen = this._szenen.filter(x => !x.stale);
      } catch (e) {
        console.error('[szenen.deleteAllStale]', e);
        this.szenenError = app.t('szenen.deleteFailed');
      } finally {
        this.staleDeleting = false;
      }
    },

    init() {
      this.$watch('viewMode', (v) => lsSet('szenen.viewMode', v));
      this._lifecycle = setupCardLifecycle(this, {
        name: 'szenen',
        showFlag: 'showSzenenCard',
        resetState: () => ({ plotBacklinks: {}, szenenLoading: false, szenenError: '', staleDeleting: false, _memos: {} }),
        load: async (root) => {
          this.szenenLoading = true;
          this.loadPlotBacklinks('scene');
          try { await root.loadSzenen(Alpine.store('nav').selectedBookId); }
          finally { this.szenenLoading = false; }
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}

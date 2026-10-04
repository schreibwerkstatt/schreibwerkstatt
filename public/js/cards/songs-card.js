// Alpine.data('songsCard') — Sub-Komponente der Musik-Karte.
//
// Eigener State: `songsLoading` (Skeleton beim ersten Laden).
// Geteilt:
//   - `songs` (Alpine.store('catalog'))
//   - `songsFilters`/`selectedSongId`/`songsUpdatedAt` (Alpine.store('catalogUi') —
//     app-navigation/Hash-Router schreiben darauf)
// Root behält:
//   - `loadSongs` (Root-Spread)
import { setupCardLifecycle } from './card-lifecycle.js';
import { applySongsFilters } from '../app/app-ui.js';
import { formatLastRun } from '../utils/date.js';

export function registerSongsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('songsCard', () => ({
    songsLoading: false,
    _lifecycle: null,

    // Gefilterte + sortierte Songs für Liste/Grid. Filter-State + Kapitel-Order
    // leben am Root (app-navigation schreibt die Filter, der Tree liefert die
    // Order-Map), darum via window.__app gelesen.
    get songsFiltered() {
      const root = window.__app;
      return applySongsFilters(root.$store.catalog.songs, Alpine.store('catalogUi').songsFilters).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    // Stand der Musikbibliothek (letzter Schreibvorgang der Komplettanalyse).
    songsUpdatedLabel() {
      const app = window.__app;
      return formatLastRun(Alpine.store('catalogUi').songsUpdatedAt, (k, p) => app.t(k, p), app.$store.shell.uiLocale);
    },

    async _loadWithFlag(tasks) {
      this.songsLoading = true;
      try { await Promise.all(tasks); } finally { this.songsLoading = false; }
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'songs',
        showFlag: 'showSongsCard',
        resetState: { songsLoading: false },
        load: (root) => this._loadWithFlag([root.loadSongs(Alpine.store('nav').selectedBookId)]),
        onShow: (root) => {
          const tasks = [root.loadSongs(Alpine.store('nav').selectedBookId)];
          if (!root.$store.catalog.figuren.length) tasks.push(root.loadFiguren(Alpine.store('nav').selectedBookId));
          return this._loadWithFlag(tasks);
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}

// Alpine.data('songsCard') — Sub-Komponente der Musik-Karte.
//
// Lade-Skelett über `cardLoading` (setupCardLifecycle).
// Geteilt:
//   - `songs` (Alpine.store('catalog'))
//   - `songsFilters`/`selectedSongId`/`songsUpdatedAt` (Alpine.store('catalogUi') —
//     app-navigation/Hash-Router schreiben darauf)
// Root behält:
//   - `loadSongs` (Root-Spread)
import { setupCardLifecycle } from './card-lifecycle.js';
import { applySongsFilters } from '../app/app-ui.js';
import { activeFilterId } from '../chapter-filter.js';
import { formatLastRun } from '../utils/date.js';
import { compareText } from '../i18n.js';

export function registerSongsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('songsCard', () => ({
    _lifecycle: null,

    // Gefilterte + sortierte Songs für Liste/Grid. Filter-State + Kapitel-Order
    // leben am Root (app-navigation schreibt die Filter, der Tree liefert die
    // Order-Map), darum via window.__app gelesen.
    get songsFiltered() {
      const root = window.__app;
      const f = Alpine.store('catalogUi').songsFilters;
      const kapitelId = activeFilterId(f.kapitelId, root.songsKapitelOptionen());
      return applySongsFilters(root.$store.catalog.songs, { ...f, kapitelId }).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => root._chapterIdIdx(k.chapter_id)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => root._chapterIdIdx(k.chapter_id)), 9999);
        if (aK !== bK) return aK - bK;
        return compareText(a.titel, b.titel);
      });
    },

    // Stand der Musikbibliothek (letzter Schreibvorgang der Komplettanalyse).
    songsUpdatedLabel() {
      const app = window.__app;
      return formatLastRun(Alpine.store('catalogUi').songsUpdatedAt, (k, p) => app.t(k, p), app.$store.shell.uiLocale);
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'songs',
        showFlag: 'showSongsCard',
        load: (root) => root.loadSongs(Alpine.store('nav').selectedBookId),
        onShow: (root) => {
          const tasks = [root.loadSongs(Alpine.store('nav').selectedBookId)];
          if (!root.$store.catalog.figuren.length) tasks.push(root.loadFiguren(Alpine.store('nav').selectedBookId));
          return Promise.all(tasks);
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}

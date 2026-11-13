// Teil von appHashRouterMethods (siehe Facade app-hash-router.js).
// Lifecycle: haengt die Watcher auf, die den Hash schreiben, und raeumt sie ab.
import { exitFullscreenOnNavigation } from '../../fullscreen.js';
import { EXCLUSIVE_CARDS } from '../../cards/feature-registry.js';
export const hashSetupMethods = {
  _setupHashRouting() {
    // Re-init sammelt sonst mehrfache $watch — bei jedem Property-Change feuern
    // dann doppelte URL-Writes mit doppeltem History-Eintrag. Existierende
    // Teardowns vorab abräumen.
    this._teardownHashRouting();
    // Karten-Flags aus EXCLUSIVE_CARDS (SSoT des Karten-Inventars) — eine neue
    // Karte schreibt so ohne Hand-Pflege ihre URL. Dazu die Nicht-Karten-
    // Quellen des Hashes (Editor, Seite, Kapitel-/Reiter-Wahl am Root).
    const watchers = [
      'currentPage', 'showEditorCard',
      'kapitelReviewChapterId', 'buchlandkarteTab', 'adminUsageTab',
      ...EXCLUSIVE_CARDS.map(c => c.flag),
    ];
    this._hashWatcherTeardowns = [];
    for (const prop of watchers) {
      const off = this.$watch(prop, () => this._updateHash());
      if (typeof off === 'function') this._hashWatcherTeardowns.push(off);
    }
    // selectedBookId + selectedXxxId leben in Stores (nav / catalogUi, keine
    // Root-Properties mehr) → Getter-Watch statt String-Pfad, sonst feuert der
    // Hash-Update nie.
    const storeWatched = [
      () => this.$store.nav.selectedBookId,
      () => this.$store.catalogUi.selectedFigurId,
      // Figuren-Reiter-Permalink: #…/figuren/<reiter> (replace, gleiche Kategorie).
      () => this.$store.catalogUi.figurenTab,
      () => this.$store.catalogUi.selectedOrtId,
      () => this.$store.catalogUi.selectedSongId,
      () => this.$store.catalogUi.selectedSzeneId,
      () => this.$store.catalogUi.selectedEreignisId,
      // Beat-Permalink: Edit öffnen setzt plotBeatId → #…/plot/<beatId> (replace,
      // gleiche Kategorie), Schliessen/Esc/Verwerfen nullt ihn → zurück auf #…/plot.
      () => this.$store.nav.plotBeatId,
      // Recherche-Item-Permalink: Öffnen/Fokussieren setzt rechercheItemId →
      // #…/recherche/<itemId> (replace, gleiche Kategorie), Schliessen nullt ihn.
      () => this.$store.nav.rechercheItemId,
      () => this.$store.nav.searchScope,
      // Reiter-Permalinks (URL_TABS): ein Eintrag je Karte, Wert = aktiver Reiter.
      () => Object.entries(this.$store.nav.cardTab).join('|'),
    ];
    for (const getter of storeWatched) {
      const off = this.$watch(getter, () => this._updateHash());
      if (typeof off === 'function') this._hashWatcherTeardowns.push(off);
    }
    window.addEventListener('hashchange', () => {
      exitFullscreenOnNavigation();
      this._applyHash();
    }, { signal: this._abortCtrl?.signal });
  },

  _teardownHashRouting() {
    if (Array.isArray(this._hashWatcherTeardowns)) {
      for (const off of this._hashWatcherTeardowns) {
        try { off(); } catch { /* noop */ }
      }
    }
    this._hashWatcherTeardowns = [];
  },
};

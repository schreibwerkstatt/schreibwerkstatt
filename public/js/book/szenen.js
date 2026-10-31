// Szenen-Lader am Root-Spread (von komplett-Job, Orte, Palette, Kapitel-Dashboard,
// Referenz-Karten gerufen). Karten-eigene Logik (Sortierung, Verteilungen,
// Stale-Löschen) liegt in cards/szenen-card.js + book/szenen-stats.js.

import { fetchJson } from '../utils.js';
import { loadToken } from '../cards/book-guard.js';

export const szenenMethods = {
  // Buchwechsel-/Doppel-Load-Guard: verspätete Antwort des vorigen Buchs (oder
  // eines älteren Loads) darf den Katalog nicht überschreiben.
  async loadSzenen(bookId) {
    const isCurrent = loadToken(this, '_szenenLoadSeq', bookId);
    try {
      const data = await fetchJson('/figures/scenes/' + bookId);
      if (!isCurrent()) return;
      this.$store.catalog.szenen = data?.szenen || [];
      this.$store.catalogUi.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },
};

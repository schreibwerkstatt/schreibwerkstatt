// Szenen-Lader am Root-Spread (von komplett-Job, Orte, Palette, Kapitel-Dashboard,
// Referenz-Karten gerufen). Karten-eigene Logik (Sortierung, Verteilungen,
// Stale-Löschen) liegt in cards/szenen-card.js + book/szenen-stats.js.

import { fetchJson } from '../utils.js';

export const szenenMethods = {
  async loadSzenen(bookId) {
    try {
      const data = await fetchJson('/figures/scenes/' + bookId);
      this.$store.catalog.szenen = data?.szenen || [];
      this.$store.catalogUi.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },
};

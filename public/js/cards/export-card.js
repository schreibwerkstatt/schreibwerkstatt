// Alpine.data('exportCard') — Sub-Komponente der Buch-Export-Karte.
// Fachlicher State lebt hier, `showExportCard` + `toggleExportCard` im Root.

import { exportMethods } from '../book/export.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('exportCard', () => ({
    bookExportLoading: null,
    bookExportError: '',
    exportScope: 'book',
    exportChapterId: null,
    exportPageId: null,
    // Migrations-Export: optionale Extra-Bloecke ins .swbook-Bundle aufnehmen.
    // Standard ist «alles»: ein Umzug soll nichts verlieren; abwählen ist die Ausnahme.
    migrateAnalysis: true,
    migrateLektorat: true,
    migrateChats: true,
    migrateResearch: true,
    migrateWerk: true,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        resetState: {
          bookExportLoading: null,
          bookExportError: '',
          exportScope: 'book',
          exportChapterId: null,
          exportPageId: null,
          migrateAnalysis: true,
          migrateLektorat: true,
          migrateChats: true,
          migrateResearch: true,
          migrateWerk: true,
        },
        extraListeners: [
          { type: 'export:preset', handler: (e) => this._applyExportPreset(e.detail) },
        ],
      });
      this.$watch(() => this.exportScope, () => this._ensurePicked());
      this.$watch(() => window.__app?.currentPage?.id, () => this._ensurePicked());
      const pending = window.__app?.__exportPreset;
      if (pending) {
        this._applyExportPreset(pending);
        window.__app.__exportPreset = null;
      }
    },

    _applyExportPreset({ kind, id } = {}) {
      if (kind === 'page' && id != null) {
        this.exportPageId = id;
        this.exportScope = 'page';
      } else if (kind === 'chapter' && id != null) {
        this.exportChapterId = id;
        this.exportScope = 'chapter';
      }
    },

    _ensurePicked() {
      const app = window.__app;
      const cur = app?.currentPage;
      if (this.exportScope === 'chapter') {
        const opts = this.exportChapterOptions();
        const valid = opts.some(o => o.value === this.exportChapterId);
        if (!valid) this.exportChapterId = cur?.chapter_id || opts[0]?.value || null;
      }
      if (this.exportScope === 'page') {
        const opts = this.exportPageOptions();
        const valid = opts.some(o => o.value === this.exportPageId);
        if (!valid) this.exportPageId = cur?.id || opts[0]?.value || null;
      }
    },

    destroy() { this._lifecycle?.destroy(); },

    ...exportMethods,
  }));
}

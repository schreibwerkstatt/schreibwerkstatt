// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung. Sub-Komponente; Show-Flag
// `showAdminBooksCard` und Toggle `toggleAdminBooksCard` leben im Root.

import { adminBooksMethods } from '../admin/admin-books.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminBooksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBooksCard', () => ({
    books: [],
    users: [],
    assignTarget: {},
    loading: false,
    busy: false,
    error: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminBooksCard',
        showNeedsBookId: false,
        onShow: () => this.loadAll(),
        onViewReset: () => { this.error = ''; },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminBooksMethods,
  }));
}

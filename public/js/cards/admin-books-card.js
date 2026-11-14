// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung. Sub-Komponente; Show-Flag
// `showAdminBooksCard` und Toggle `toggleAdminBooksCard` leben im Root.

import { adminBooksMethods } from '../admin/admin-books.js';
import { adminLoaderState } from '../admin/admin-loader.js';
import { pickerPopoverState } from '../picker-popover.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminBooksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBooksCard', () => ({
    ...adminLoaderState('adminBooks'),
    ...pickerPopoverState(),
    books: [],
    users: [],
    assignBookId: null,
    assignEmail: '',
    adminBooksBusy: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminBooksCard',
        showNeedsBookId: false,
        // Jedes Oeffnen laedt neu (Besitz aendert sich auch ausserhalb der Karte);
        // die Tabellen bleiben dabei stehen.
        onShow: () => this.adminBooksRefresh(),
        onHide: () => this.cancelAssign(),
        onViewReset: () => {
          this.cancelAssign();
          this._adminBooksInvalidate();
        },
      });
    },

    destroy() {
      this.cancelAssign();
      this._lifecycle?.destroy();
    },

    ...adminBooksMethods,
  }));
}

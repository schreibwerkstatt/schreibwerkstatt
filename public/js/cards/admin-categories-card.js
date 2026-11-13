// Alpine-Sub-Komponente fuer den Kategorien-Pool (Admin-only). State +
// Lifecycle hier, Show-Flag (`showAdminCategoriesCard`) im Root.

import { adminCategoriesMethods } from '../admin/admin-categories.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminCategoriesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminCategoriesCard', () => ({
    categories: [],
    loading: false,
    busy: false,
    error: '',
    newCategoryName: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminCategoriesCard',
        showNeedsBookId: false,
        onShow: () => this.loadAll(),
        onViewReset: () => { this.error = ''; },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminCategoriesMethods,
  }));
}

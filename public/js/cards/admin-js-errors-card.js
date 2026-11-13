// Alpine-Sub-Komponente fuer die Client-JS-Fehler-Karte. Sichtbarkeit ueber
// $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminJsErrorsCard`) im Root.

import { adminJsErrorsMethods } from '../admin/js-errors.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminJsErrorsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminJsErrorsCard', () => ({
    jsErrorsInitialized: false,
    jsErrorsLoading: false,
    jsErrorsError: '',
    jsErrorsList: [],
    jsErrorsExpanded: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminJsErrorsCard',
        showNeedsBookId: false,
        onShow: () => this.jsErrorsEnter(),
        onHide: () => this._jsErrorsLeave(),
        onViewReset: () => {
          this._jsErrorsLeave();
          this.jsErrorsList = [];
          this.jsErrorsExpanded = {};
          this.jsErrorsError = '';
          this.jsErrorsInitialized = false;
        },
      });
    },

    destroy() {
      this._jsErrorsLeave();
      this._lifecycle?.destroy();
    },

    ...adminJsErrorsMethods,
  }));
}

// Alpine-Sub-Komponente fuer die Client-JS-Fehler-Karte. Sichtbarkeit ueber
// $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminJsErrorsCard`) im Root.

import { adminJsErrorsMethods } from '../admin/js-errors.js';
import { adminLoaderState } from '../admin/admin-loader.js';
import { listWindowState, listWindowMethods } from '../list-window.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminJsErrorsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminJsErrorsCard', () => ({
    ...adminLoaderState('jsErrors'),
    ...listWindowState(),
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
          this._jsErrorsInvalidate();
          this.jsErrorsList = [];
          this.jsErrorsExpanded = {};
          Object.assign(this, listWindowState());
        },
      });
    },

    destroy() {
      this._jsErrorsLeave();
      this._lifecycle?.destroy();
    },

    ...listWindowMethods,
    ...adminJsErrorsMethods,
  }));
}

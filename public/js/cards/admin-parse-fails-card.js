// Alpine-Sub-Komponente fuer die KI-Parse-Fehler-Karte. Sichtbarkeit ueber
// $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminParseFailsCard`) im Root.

import { adminParseFailsMethods } from '../admin/ai-parse-fails.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminParseFailsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminParseFailsCard', () => ({
    parseFailsInitialized: false,
    parseFailsLoading: false,
    parseFailsError: '',
    parseFailsFiles: [],
    parseFailsContent: {},
    parseFailsExpanded: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminParseFailsCard',
        showNeedsBookId: false,
        onShow: () => this.parseFailsEnter(),
        onHide: () => this._parseFailsLeave(),
        onViewReset: () => {
          this._parseFailsLeave();
          this.parseFailsFiles = [];
          this.parseFailsContent = {};
          this.parseFailsExpanded = {};
          this.parseFailsError = '';
          this.parseFailsInitialized = false;
        },
      });
    },

    destroy() {
      this._parseFailsLeave();
      this._lifecycle?.destroy();
    },

    ...adminParseFailsMethods,
  }));
}

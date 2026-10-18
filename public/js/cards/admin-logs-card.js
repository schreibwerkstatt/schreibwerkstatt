// Alpine-Sub-Komponente fuer die Admin-Logs-Karte. Sichtbarkeit ueber
// $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminLogsCard`) im Root.

import { adminLogsMethods, ADMIN_LOGS_LEVELS } from '../admin/admin-logs.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminLogsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminLogsCard', () => ({
    adminLogsInitialized: false,
    adminLogsLoading: false,
    adminLogsError: '',
    adminLogsEntries: [],
    adminLogsFiles: [],
    adminLogsFilter: { level: '', scope: '', user: '', book: '', q: '' },
    adminLogsLiveTail: true,
    adminLogsEventSource: null,
    adminLogsStreamError: false,
    adminLogsRotatedHint: false,
    adminLogsHasMore: true,
    adminLogsOldestTs: null,
    adminLogsExpanded: {},
    adminLogsPage: 0,
    adminLogsPending: [],
    _adminLogsIncoming: [],
    _adminLogsFlushTimer: null,
    _adminLogsSeq: 0,
    adminLogsLevels: ADMIN_LOGS_LEVELS,
    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showAdminLogsCard, async (visible) => {
        if (visible) {
          await this.adminLogsEnter();
        } else {
          this._adminLogsLeave();
        }
      });
      this._lifecycle = setupCardLifecycle(this, {
        onViewReset: () => {
          this._adminLogsLeave();
          this._adminLogsResetList();
          this.adminLogsError = '';
          this.adminLogsInitialized = false;
        },
      });
    },

    destroy() {
      this._adminLogsLeave();
      this._lifecycle?.destroy();
    },

    ...adminLogsMethods,
  }));
}

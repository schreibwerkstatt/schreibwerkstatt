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
    // Zuletzt angewendeter Filter — bestimmt Tail+Live vs. Suchergebnis.
    adminLogsApplied: { level: '', scope: '', user: '', book: '', q: '' },
    adminLogsScopes: [],
    adminLogsServerTz: null,
    adminLogsDownloading: null,
    _adminLogsReqSeq: 0,
    _adminLogsApplyTimer: null,
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
      // Filterfelder wenden sich selbst an (entprellt, admin-logs.js).
      this.$watch('adminLogsFilter', () => this._adminLogsScheduleApply());
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminLogsCard',
        showNeedsBookId: false,
        onShow: () => this.adminLogsEnter(),
        onHide: () => this._adminLogsLeave(),
        onViewReset: () => {
          this._adminLogsLeave();
          this._adminLogsResetList();
          this._adminLogsReqSeq++;
          this.adminLogsLoading = false;
          this.adminLogsError = '';
          this.adminLogsScopes = [];
          this.adminLogsInitialized = false;
        },
      });
    },

    destroy() {
      clearTimeout(this._adminLogsApplyTimer);
      this._adminLogsLeave();
      this._lifecycle?.destroy();
    },

    ...adminLogsMethods,
  }));
}

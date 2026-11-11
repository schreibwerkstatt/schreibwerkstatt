// Alpine-Sub-Komponente fuer die Admin-Backup-Karte (kontoweites DB-Backup +
// Restore). Sichtbarkeit ueber $store.session.currentUser.isAdmin; State +
// Lifecycle hier, Show-Flag (`showAdminBackupCard`) im Root.

import { adminBackupMethods } from '../admin/admin-backup.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminBackupCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBackupCard', () => ({
    backupInitialized: false,
    backupLoading: false,
    backupError: '',
    backupInfoData: null,
    backupDownloading: false,
    backupFile: null,
    backupRestoring: false,
    backupRestoreResult: null,
    backupRestoreError: '',
    backupRestarting: false,
    backupRestartTimedOut: false,
    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showAdminBackupCard, async (visible) => {
        if (visible) await this.backupEnter();
      });
      this._lifecycle = setupCardLifecycle(this, {
        name: 'adminBackup',
        refreshNeedsBookId: false,
        onCardRefresh: () => this.backupRefresh(),
        wake: () => this._backupLoadInfo({ silent: true }),
        onViewReset: () => {
          this.backupInitialized = false;
          this.backupInfoData = null;
          this.backupError = '';
          this.backupFile = null;
          this.backupRestoreResult = null;
          this.backupRestoreError = '';
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminBackupMethods,
  }));
}

// Alpine-Sub-Komponente fuer die Admin-Backup-Karte (kontoweites DB-Backup +
// Restore). Sichtbarkeit ueber $store.session.currentUser.isAdmin; State +
// Lifecycle hier, Show-Flag (`showAdminBackupCard`) im Root.

import { adminBackupMethods } from '../admin/admin-backup.js';
import { adminLoaderState } from '../admin/admin-loader.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminBackupCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminBackupCard', () => ({
    ...adminLoaderState('backup'),
    backupInfoData: null,
    backupDownloading: false,
    backupDownloadError: '',
    backupFile: null,
    backupRestoring: false,
    backupRestoreResult: null,
    backupRestoreError: '',
    backupDiscarding: false,
    backupRestarting: false,
    backupRestartTimedOut: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'adminBackup',
        showFlag: 'showAdminBackupCard',
        showNeedsBookId: false,
        onShow: () => this.backupEnter(),
        refreshNeedsBookId: false,
        onCardRefresh: () => this.backupRefresh(),
        wake: () => this._backupLoad({ silent: true }),
        onViewReset: () => {
          this._backupInvalidate();
          this.backupInfoData = null;
          this.backupDownloadError = '';
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

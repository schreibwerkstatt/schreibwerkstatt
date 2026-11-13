// Alpine-Sub-Komponente fuer die Admin-Geraete-Karte (native Mac-Focus-Clients).
// Sichtbarkeit ueber $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminDevicesCard`) im Root.

import { adminDevicesMethods } from '../admin/admin-devices.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerAdminDevicesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminDevicesCard', () => ({
    devicesInitialized: false,
    devicesLoading: false,
    devicesError: '',
    devicesList: [],
    devicesLatestVersions: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'adminDevices',
        showFlag: 'showAdminDevicesCard',
        showNeedsBookId: false,
        onShow: () => this.devicesEnter(),
        refreshNeedsBookId: false,
        onCardRefresh: () => this.devicesRefresh(),
        wake: () => this._devicesLoad({ silent: true }),
        onViewReset: () => {
          this.devicesList = [];
          this.devicesError = '';
          this.devicesLatestVersions = {};
          this.devicesInitialized = false;
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminDevicesMethods,
  }));
}

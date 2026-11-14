// Alpine-Sub-Komponente fuer die Admin-Geraete-Karte (native Mac-Focus-Clients).
// Sichtbarkeit ueber $store.session.currentUser.isAdmin; State + Lifecycle hier, Show-Flag
// (`showAdminDevicesCard`) im Root.

import { adminDevicesMethods } from '../admin/admin-devices.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { adminLoaderState } from '../admin/admin-loader.js';

export function registerAdminDevicesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminDevicesCard', () => ({
    ...adminLoaderState('devices'),
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
          this._devicesInvalidate();
          this.devicesList = [];
          this.devicesLatestVersions = {};
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminDevicesMethods,
  }));
}

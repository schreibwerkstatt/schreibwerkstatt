// Alpine-Sub-Komponente fuer Admin-Settings. Sichtbarkeit ueber $store.session.currentUser.role;
// State + Lifecycle hier, Show-Flag (`showAdminSettingsCard`) im Root.

import { adminSettingsMethods } from '../admin/admin-settings.js';
import { adminAiProfilesMethods } from '../admin/admin-ai-profiles.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { CARD_REQUEST } from './card-request.js';
import { ADMIN_SETTINGS_TABS } from '../admin/admin-settings-tabs.js';
import { adminFormatMethods } from '../admin/admin-format.js';

export function registerAdminSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminSettingsCard', () => ({
    adminSettingsMap: {},
    adminSettingsForm: {},
    adminSettingsLoading: false,
    adminSettingsSaving: false,
    adminSettingsSaved: false,
    adminSettingsSavedCount: 0,
    adminSettingsError: '',
    adminSettingsTab: 'auth',
    adminSettingsTabs: ADMIN_SETTINGS_TABS,
    adminSettingsProviderSubtab: 'claude',
    adminSettingsLoadedOnce: false,          // Provider-Unterreiter nur beim ersten Laden setzen
    adminSettingsPendingReset: {},           // key → true: beim Speichern auf Standard zurück
    adminSettingsAuth: { own_has_password: false, env_admin: false },
    adminSettingsOwnPassword: '',
    adminSettingsOwnPasswordBusy: false,
    adminSettingsTestResult: null,

    // ── KI-Profile (Provider-Tab, Sub-Tab `profiles`) ───────────────────────
    adminProfilesList: [],
    adminProfilesLoading: false,
    adminProfilesError: '',
    adminProfilesEditing: false,
    adminProfilesSaving: false,
    adminProfilesForm: {},

    // ── API-Tokens (Tab `api`) — Prometheus/HA/Grafana-Scraper ──────────────
    adminApiTokensList: [],
    adminApiTokensLoading: false,
    adminApiTokensLoaded: false,
    adminApiTokensError: '',
    adminApiTokensCreating: false,
    adminApiTokensNewName: '',
    adminApiTokensNewExpiresAt: '',
    adminApiTokensNewIncludeUsers: false,
    adminApiTokensJustCreated: null,

    _lifecycle: null,

    init() {
      // Profil-Liste erst beim Betreten des Sub-Tabs holen — die Karte oeffnet
      // meistens fuer etwas anderes.
      this.$watch('adminSettingsProviderSubtab', (t) => {
        if (t === 'profiles' && !this.adminProfilesList.length) this.adminProfilesLoad();
      });
      // Nachlade-Effekt eines Reiters (API-Tokens) an jedem Weg, der den Reiter
      // setzt — auch an der x-model-Bindung der Reiterleiste.
      this.$watch('adminSettingsTab', (t) => this._adminSettingsOnTab(t));
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminSettingsCard',
        showNeedsBookId: false,
        // Ungespeicherte Änderungen überleben das Schliessen der Karte; beim
        // Wiederöffnen wird erst gefragt, bevor ein Neu-Laden sie verwirft.
        onShow: async () => {
          if (this.adminSettingsLoadedOnce && !(await this.adminSettingsConfirmDiscard())) return;
          await this.adminSettingsLoad();
        },
        // Browser-Reload/Tab-Close: nativer Prompt (appConfirm geht in
        // beforeunload nicht).
        extraListeners: [{ type: 'beforeunload', handler: (e) => {
          if (!window.__app?.showAdminSettingsCard || !this.adminSettingsHasChanges()) return;
          e.preventDefault();
          e.returnValue = '';
        } }],
        tabRequest: { key: CARD_REQUEST.ADMIN_SETTINGS_TAB, apply: (tab) => this.adminSettingsSwitchTab(tab), current: () => this.adminSettingsTab },
        onViewReset: () => {
          this.adminSettingsError = '';
          this.adminSettingsTestResult = null;
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminSettingsMethods,
    ...adminAiProfilesMethods,
    ...adminFormatMethods,
  }));
}

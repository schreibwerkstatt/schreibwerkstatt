// Alpine-Sub-Komponente fuer Admin-Settings. Sichtbarkeit ueber $store.session.currentUser.role;
// State + Lifecycle hier, Show-Flag (`showAdminSettingsCard`) im Root.

import { adminSettingsMethods } from '../admin/admin-settings.js';
import { adminAiProfilesMethods } from '../admin/admin-ai-profiles.js';
import { setupCardLifecycle } from './card-lifecycle.js';

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
    adminSettingsProviderSubtab: 'claude',
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
      this.$watch(() => window.__app.showAdminSettingsCard, async (visible) => {
        if (!visible) return;
        await this.adminSettingsLoad();
      });
      // Profil-Liste erst beim Betreten des Sub-Tabs holen — die Karte oeffnet
      // meistens fuer etwas anderes.
      this.$watch('adminSettingsProviderSubtab', (t) => {
        if (t === 'profiles' && !this.adminProfilesList.length) this.adminProfilesLoad();
      });
      this._lifecycle = setupCardLifecycle(this, {
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
  }));
}

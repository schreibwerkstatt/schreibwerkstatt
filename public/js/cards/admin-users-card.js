// Alpine-Sub-Komponente fuer die Admin-User-Liste. Sichtbarkeit ueber
// $store.session.currentUser.role; State + Lifecycle hier, Show-Flag
// (`showAdminUsersCard`) im Root.

import { adminUsersMethods } from '../admin/admin-users.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { CARD_REQUEST } from './card-request.js';

export function registerAdminUsersCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminUsersCard', () => ({
    adminUsersList: [],
    adminUsersLoading: false,
    adminUsersError: '',
    adminUsersGlobalProvider: 'claude',  // fuer Profil-Combobox-Label "Global: …"
    adminUsersProfiles: [],              // zuweisbare KI-Profile (/admin/ai-profiles)
    adminUsersInviteEmail: '',
    adminUsersInviteRole: 'user',
    adminUsersInviting: false,
    adminUsersInviteResult: null,
    adminUsersAuditEmail: null,
    adminUsersAuditEvents: [],
    // Aktives Anmeldeverfahren (vom Server, nicht geraten): steuert, ob die
    // Passwort-Spalte ueberhaupt Sinn hat.
    adminUsersAuthMethod: 'google',
    adminUsersPasswordEmail: null,           // offener Passwort-Drawer
    adminUsersPasswordValue: '',
    adminUsersPasswordBusy: null,            // email waehrend set/link/remove
    adminUsersPasswordResult: null,          // { url, expiresAt, mail }
    // Registration-Requests-Tab.
    adminUsersTab: 'users',                  // 'users' | 'invites' | 'requests'
    adminUsersRequestsList: [],
    adminUsersRequestsStatus: 'pending',     // pending|approved|denied|expired|all
    adminUsersRequestsLoading: false,
    adminUsersRequestsBusy: null,            // id during approve/deny
    adminUsersRequestsResult: null,          // { id, inviteUrl, mail }
    // Invites-Tab (offene Einladungen).
    adminUsersInvitesList: [],
    adminUsersInvitesLoading: false,
    adminUsersInvitesBusy: null,             // id during remind/revoke
    adminUsersInvitesResult: null,           // { id, mail | cooldown, retryAfter }

    _lifecycle: null,

    init() {
      this.$watch(() => window.__app.showAdminUsersCard, async (visible) => {
        if (!visible) return;
        await this.adminUsersLoad();
        if (this.adminUsersTab === 'requests') await this.adminUsersRequestsLoad();
        if (this.adminUsersTab === 'invites')  await this.adminUsersInvitesLoad();
      });
      this.$watch(() => this.adminUsersTab, async (tab) => {
        if (tab === 'requests') await this.adminUsersRequestsLoad();
        if (tab === 'invites')  await this.adminUsersInvitesLoad();
      });
      this.$watch(() => this.adminUsersRequestsStatus, async () => {
        if (this.adminUsersTab === 'requests') await this.adminUsersRequestsLoad();
      });
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showAdminUsersCard',
        tabRequest: { key: CARD_REQUEST.ADMIN_USERS_TAB, apply: (tab) => { this.adminUsersTab = tab; }, current: () => this.adminUsersTab },
        onViewReset: () => {
          this.adminUsersError = '';
          this.adminUsersInviteResult = null;
          this.adminUsersAuditEmail = null;
          this.adminUsersAuditEvents = [];
          this.adminUsersRequestsResult = null;
          this.adminUsersInvitesResult = null;
          this.adminUsersPasswordEmail = null;
          this.adminUsersPasswordValue = '';
          this.adminUsersPasswordResult = null;
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...adminUsersMethods,
  }));
}

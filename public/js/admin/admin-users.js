// AdminUsersCard-Methods.
// Wird im adminUsersCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`, weil Alpine-Magics in JS-Methoden nicht zuverlaessig sind.

import { fetchJson, sendJson } from '../utils.js';
import { tFetchErrorRaw } from '../i18n.js';

export const adminUsersMethods = {
  async adminUsersLoad() {
    if (this.adminUsersLoading) return;
    this.adminUsersLoading = true;
    this.adminUsersError = '';
    try {
      const [data, s, p] = await Promise.all([
        fetchJson('/admin/users'),
        fetchJson('/admin/settings/ai.provider').catch(() => null),
        fetchJson('/admin/ai-profiles').catch(() => null),
      ]);
      this.adminUsersList = data.users || [];
      if (data.auth_method) this.adminUsersAuthMethod = data.auth_method;
      const v = s?.setting?.value;
      if (typeof v === 'string') this.adminUsersGlobalProvider = v;
      // Zuweisbare KI-Profile fuer die Combobox je Zeile. Faellt der Call aus,
      // bleibt die Liste leer — die Zeile zeigt dann nur „Global: <provider>",
      // und eine bestehende Zuweisung bleibt unangetastet.
      if (p) this.adminUsersProfiles = Array.isArray(p.profiles) ? p.profiles : [];
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersLoading = false;
    }
  },

  async adminUsersInvite() {
    const email = (this.adminUsersInviteEmail || '').trim();
    if (!email) return;
    this.adminUsersInviting = true;
    this.adminUsersError = '';
    this.adminUsersInviteResult = null;
    try {
      const j = await sendJson('/admin/users/invite', 'POST', { email, role: this.adminUsersInviteRole || 'user' });
      const url = j.inviteUrl
        ? (j.inviteUrl.startsWith('http') ? j.inviteUrl : `${location.origin}${j.inviteUrl}`)
        : `${location.origin}/invite/${j.invite.invite_token}`;
      this.adminUsersInviteResult = {
        email: j.invite.email,
        token: j.invite.invite_token,
        url,
        mail: j.mail || null,
      };
      this.adminUsersInviteEmail = '';
      if (this.adminUsersTab === 'invites') await this.adminUsersInvitesLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersInviting = false;
    }
  },

  // ── Passwoerter (nur bei auth.method='local') ──────────────────────────────
  // Drei Wege, ein Ergebnis: Initialpasswort vom Admin, Setz-/Reset-Link per
  // Mail, oder Entzug. Alle drei laufen ueber /admin/users/:email/password*
  // und laden danach die Liste neu, damit die Badge stimmt.

  adminUsersPasswordOpen(u) {
    this.adminUsersPasswordEmail = u.email;
    this.adminUsersPasswordValue = '';
    this.adminUsersPasswordResult = null;
  },

  async _adminUsersPasswordCall(email, path, method, body) {
    this.adminUsersPasswordBusy = email;
    this.adminUsersError = '';
    try {
      const j = await sendJson(`/admin/users/${encodeURIComponent(email)}${path}`, method, body);
      await this.adminUsersLoad();
      return j || {};
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
      return null;
    } finally {
      this.adminUsersPasswordBusy = null;
    }
  },

  async adminUsersPasswordSave() {
    const email = this.adminUsersPasswordEmail;
    const password = this.adminUsersPasswordValue;
    if (!email || !password) return;
    const j = await this._adminUsersPasswordCall(email, '/password', 'POST', { password });
    if (!j) return;
    this.adminUsersPasswordEmail = null;
    this.adminUsersPasswordValue = '';
    this.adminUsersPasswordResult = null;
  },

  async adminUsersPasswordLink(u) {
    const j = await this._adminUsersPasswordCall(u.email, '/password-link', 'POST');
    if (!j) return;
    const url = j.url && !j.url.startsWith('http') ? `${location.origin}${j.url}` : j.url;
    this.adminUsersPasswordResult = { email: u.email, url, expiresAt: j.expiresAt, mail: j.mail || null };
  },

  async adminUsersPasswordRemove(u) {
    if (!await window.__app.appConfirm({ message: window.__app.t('admin.users.password.removeConfirm', { email: u.email }), danger: true })) return;
    await this._adminUsersPasswordCall(u.email, '/password', 'DELETE');
  },

  async adminUsersInvitesLoad() {
    if (this.adminUsersInvitesLoading) return;
    this.adminUsersInvitesLoading = true;
    this.adminUsersError = '';
    try {
      const j = await fetchJson('/admin/users/invites');
      this.adminUsersInvitesList = j.invites || [];
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersInvitesLoading = false;
    }
  },

  async adminUsersInviteRemind(inv) {
    if (!inv || this.adminUsersInvitesBusy) return;
    this.adminUsersInvitesBusy = inv.id;
    this.adminUsersError = '';
    this.adminUsersInvitesResult = null;
    try {
      let j;
      try {
        j = await sendJson(`/admin/users/invites/${inv.id}/remind`, 'POST');
      } catch (e) {
        if (e.code === 'REMINDER_COOLDOWN') {
          this.adminUsersInvitesResult = { id: inv.id, cooldown: true, retryAfter: e.body?.retryAfter };
          return;
        }
        throw e;
      }
      this.adminUsersInvitesResult = { id: inv.id, mail: j.mail };
      await this.adminUsersInvitesLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersInvitesBusy = null;
    }
  },

  async adminUsersInviteRevoke(inv) {
    if (!inv || this.adminUsersInvitesBusy) return;
    const confirmMsg = window.__app?.t?.('admin.users.invites.confirmRevoke', { email: inv.email })
      || `Einladung an ${inv.email} widerrufen?`;
    if (!await window.__app.appConfirm({ message: confirmMsg, danger: true })) return;
    this.adminUsersInvitesBusy = inv.id;
    this.adminUsersError = '';
    try {
      await sendJson(`/admin/users/invites/${inv.id}`, 'DELETE');
      await this.adminUsersInvitesLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersInvitesBusy = null;
    }
  },

  async adminUsersUpdate(user, patch) {
    this.adminUsersError = '';
    try {
      const j = await sendJson(`/admin/users/${encodeURIComponent(user.email)}`, 'PUT', patch);
      const idx = this.adminUsersList.findIndex(u => u.email === user.email);
      if (idx >= 0) this.adminUsersList.splice(idx, 1, j.user);
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    }
  },

  async adminUsersDelete(user) {
    const me = Alpine.store('session').currentUser?.email;
    if (user.email === me) { this.adminUsersError = 'CANNOT_DELETE_SELF'; return; }
    if (!await window.__app.appConfirm({ message: window.__app.t('admin.users.confirmDelete', { email: user.email }), danger: true })) return;
    this.adminUsersError = '';
    try {
      await sendJson(`/admin/users/${encodeURIComponent(user.email)}`, 'DELETE');
      await this.adminUsersLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    }
  },

  async adminUsersToggleAudit(user) {
    if (this.adminUsersAuditEmail === user.email) {
      this.adminUsersAuditEmail = null;
      this.adminUsersAuditEvents = [];
      return;
    }
    this.adminUsersAuditEmail = user.email;
    this.adminUsersAuditEvents = [];
    try {
      const j = await fetchJson(`/admin/users/${encodeURIComponent(user.email)}/audit?limit=50`);
      this.adminUsersAuditEvents = j.events || [];
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    }
  },

  // ─── Registration-Requests ─────────────────────────────────────────────

  async adminUsersRequestsLoad() {
    if (this.adminUsersRequestsLoading) return;
    this.adminUsersRequestsLoading = true;
    this.adminUsersError = '';
    try {
      const status = this.adminUsersRequestsStatus || 'pending';
      const data = await fetchJson(`/admin/registration-requests?status=${encodeURIComponent(status)}`);
      this.adminUsersRequestsList = data.items || [];
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersRequestsLoading = false;
    }
  },

  async adminUsersApproveRequest(req, role = 'user') {
    if (!req || this.adminUsersRequestsBusy) return;
    this.adminUsersRequestsBusy = req.id;
    this.adminUsersError = '';
    this.adminUsersRequestsResult = null;
    try {
      const j = await sendJson(`/admin/registration-requests/${req.id}/approve`, 'POST', { role });
      this.adminUsersRequestsResult = { id: req.id, inviteUrl: j.inviteUrl, mail: j.mail };
      await this.adminUsersRequestsLoad();
      await this.adminUsersLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersRequestsBusy = null;
    }
  },

  async adminUsersDenyRequest(req) {
    if (!req || this.adminUsersRequestsBusy) return;
    const reason = await window.__app.appPrompt({
      message: window.__app.t('admin.users.requests.denyReasonPrompt'),
      allowEmpty: true,
    });
    // null = Cancel → abbrechen; '' = bestaetigt ohne Reason → erlauben.
    if (reason === null) return;
    this.adminUsersRequestsBusy = req.id;
    this.adminUsersError = '';
    try {
      await sendJson(`/admin/registration-requests/${req.id}/deny`, 'POST', { reason });
      await this.adminUsersRequestsLoad();
    } catch (e) {
      this.adminUsersError = tFetchErrorRaw(e);
    } finally {
      this.adminUsersRequestsBusy = null;
    }
  },

};

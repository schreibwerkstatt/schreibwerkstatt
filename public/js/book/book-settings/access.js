// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { fetchJson } from './_shared.js';

export const accessMethods = {

  // ── Sharing ────────────────────────────────────────────────────────────────

  async loadBookAccess() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.bookAccessList = []; return; }
    this.bookAccessLoading = true;
    this.bookAccessError = '';
    try {
      const data = await fetchJson(`/books/${bookId}/access`);
      this.bookAccessList = data?.access || [];
    } catch (e) {
      this.bookAccessError = e.message;
    } finally {
      this.bookAccessLoading = false;
    }
  },


  // Owner darf sharen; Server enforced final.
  bookAccessIsOwner() {
    return window.__app.currentBookRole === 'owner';
  },


  shareInitials(entry) {
    const name = (entry?.display_name || '').trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return parts[0].slice(0, 2).toUpperCase();
    }
    const local = (entry?.user_email || '').split('@')[0];
    return local.slice(0, 2).toUpperCase();
  },


  _shareEmailValid(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },


  shareCanInvite() {
    const u = Alpine.store('session').currentUser;
    // Spiegelt das Server-Gate: Admins laden immer ein, sonst nur mit Freigabe.
    return !!(u?.can_invite_users || u?.isAdmin);
  },


  // Versucht zuerst zu teilen; existiert der User noch nicht (USER_NOT_FOUND)
  // und darf der aktuelle User einladen, wird stattdessen eine Einladung
  // verschickt. Geteilt wird dann erst nach Annahme der Einladung.
  async submitShareInvite() {
    if (!this.bookAccessIsOwner()) return;
    const bookId = Alpine.store('nav').selectedBookId;
    const email = (this.shareEmail || '').trim().toLowerCase();
    const role = this.shareRole;
    if (!bookId || !email) return;
    if (!this._shareEmailValid(email)) {
      this.bookAccessError = window.__app.t('book.share.emailInvalid');
      return;
    }
    this.shareBusy = true;
    this.bookAccessError = '';
    this.shareInviteMessage = '';
    if (this._shareInviteMsgTimer) { clearTimeout(this._shareInviteMsgTimer); this._shareInviteMsgTimer = null; }
    try {
      const shareRes = await fetch(`/books/${bookId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const shareData = await shareRes.json().catch(() => ({}));
      if (shareRes.ok) {
        this.shareEmail = '';
        await this.loadBookAccess();
        // Das neue Mitglied gehoert jetzt zum Sichtkreis von `/me/users-light`.
        window.__app.refreshUsersLight?.();
        return;
      }
      if (shareData?.error_code === 'USER_NOT_FOUND' && this.shareCanInvite()) {
        const inviteRes = await fetch('/me/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const inviteData = await inviteRes.json().catch(() => ({}));
        if (!inviteRes.ok) throw new Error(window.__app.tError(inviteData) || `HTTP ${inviteRes.status}`);
        this.shareEmail = '';
        this.shareInviteMessage = window.__app.t('book.share.inviteSent', { email });
        this._shareInviteMsgTimer = setTimeout(() => { this.shareInviteMessage = ''; this._shareInviteMsgTimer = null; }, 6000);
        return;
      }
      throw new Error(window.__app.tError(shareData) || `HTTP ${shareRes.status}`);
    } catch (e) {
      this.bookAccessError = e.message;
    } finally {
      this.shareBusy = false;
    }
  },


  async changeBookAccessRole(email, newRole) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = Alpine.store('nav').selectedBookId;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/access/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },


  async revokeBookAccess(email) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!await window.__app.appConfirm({
      message: window.__app.t('book.share.revokeConfirm', { email }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/access/${encodeURIComponent(email)}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },


  async transferOwnership(email) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!await window.__app.appConfirm({
      message: window.__app.t('book.share.transferConfirm', { email }),
      confirmLabel: window.__app.t('book.share.transferConfirmBtn'),
      danger: true,
    })) return;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/transfer-ownership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      // Rollen cachen invalidieren + neu laden.
      window.__app.bookRoles = {};
      window.__app.currentBookRole = null;
      if (window.__app._loadBookRole) await window.__app._loadBookRole(bookId);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },


  bookAccessRoleOptions() {
    const app = window.__app;
    return [
      { value: 'viewer', label: app.t('book.share.role.viewer') },
      { value: 'lektor', label: app.t('book.share.role.lektor') },
      { value: 'editor', label: app.t('book.share.role.editor') },
    ];
  },
};

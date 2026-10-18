// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { fetchJson } from './_shared.js';
import {
  syncErrorText, postSyncJson, rehydrateSyncJobs, startSyncJob, deleteSyncConnection,
} from './sync-shared.js';

export const hubspotMethods = {

  // ─── HubSpot-Sync ────────────────────────────────────────────────────────
  // Sichtbar nur bei buchtyp === 'blog'. State im Card-Init: hubspotConnection,
  // hubspotForm, hubspotBusy/Action/Message/Error, hubspotBlogs, hubspotAuthors,
  // hubspotImportJobId, hubspotReconcileJobId. Was WordPress genauso macht,
  // steht in ./sync-shared.js.

  async loadHubspotStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/hubspot/${bookId}/status`);
      this.hubspotConnection = data.connection || null;
      if (this.hubspotConnection) {
        this.hubspotForm.blogId   = this.hubspotConnection.blogId || '';
        this.hubspotForm.authorId = this.hubspotConnection.authorId || '';
        // Listen mit dem gespeicherten Token nachladen, damit die Comboboxen
        // den aktuellen Wert als Label zeigen können.
        this.loadHubspotLists();
      }
      [this.hubspotImportJobId, this.hubspotReconcileJobId] =
        await rehydrateSyncJobs(bookId, ['hubspot-import', 'hubspot-reconcile']);
    } catch (e) {
      console.error('[hubspot] Status laden fehlgeschlagen:', e);
    }
  },


  hubspotFormReady() {
    const hasToken = !!this.hubspotForm.token || !!this.hubspotConnection;
    return hasToken && !!this.hubspotForm.blogId && !!this.hubspotForm.authorId;
  },


  _setHubspotBusy(action) {
    this.hubspotBusy = !!action;
    this.hubspotAction = action || null;
    if (action) { this.hubspotMessage = ''; this.hubspotError = ''; }
  },


  // Token im Body: eingegebenes Token, sonst `__keep__` (= das gespeicherte).
  // Nie in der URL — eine Query landet in Verlauf und Proxy-Logs.
  _hubspotTokenBody() {
    if (this.hubspotForm.token) return { token: this.hubspotForm.token };
    return this.hubspotConnection ? { token: '__keep__' } : {};
  },


  hubspotBlogOptions() {
    return (this.hubspotBlogs || []).map(b => ({ value: b.id, label: b.name }));
  },


  hubspotAuthorOptions() {
    return (this.hubspotAuthors || []).map(a => ({
      value: a.id,
      label: a.email ? `${a.name} <${a.email}>` : a.name,
    }));
  },


  async testHubspotConnection() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this._setHubspotBusy('test');
    try {
      await postSyncJson(`/hubspot/${bookId}/test`, this._hubspotTokenBody(), 'HUBSPOT_TEST_FAILED');
      this.hubspotMessage = window.__app.t('hubspot.connect.testOk');
      await this.loadHubspotLists();
    } catch (e) {
      this.hubspotError = syncErrorText('hubspot', e.message);
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async loadHubspotLists() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const body = this._hubspotTokenBody();
    try {
      const [blogs, authors] = await Promise.all([
        postSyncJson(`/hubspot/${bookId}/blogs`, body, 'HUBSPOT_LISTS_FAILED'),
        postSyncJson(`/hubspot/${bookId}/authors`, body, 'HUBSPOT_LISTS_FAILED'),
      ]);
      this.hubspotBlogs = blogs.blogs || [];
      this.hubspotAuthors = authors.authors || [];
    } catch (e) {
      this.hubspotError = syncErrorText('hubspot', e.message);
    }
  },


  async saveHubspotConnection() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.hubspotFormReady()) return;
    this._setHubspotBusy('save');
    try {
      const data = await postSyncJson(`/hubspot/${bookId}/connect`, {
        blogId: this.hubspotForm.blogId,
        authorId: this.hubspotForm.authorId,
        ...this._hubspotTokenBody(),
      }, 'HUBSPOT_SAVE_FAILED');
      this.hubspotConnection = data.connection;
      this.hubspotForm.token = '';
      this.hubspotMessage = window.__app.t(data.targetChanged ? 'hubspot.connect.targetChanged' : 'hubspot.connect.saved');
      // Links/Import-Stand verworfen → Badges im Buchorganizer neu laden.
      if (data.targetChanged) window.__hubspotCard?.loadLinks?.();
    } catch (e) {
      this.hubspotError = syncErrorText('hubspot', e.message);
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async disconnectHubspot() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    if (!confirm(window.__app.t('hubspot.connect.disconnectConfirm'))) return;
    this._setHubspotBusy('disconnect');
    try {
      await deleteSyncConnection('/hubspot', bookId, 'HUBSPOT_DISCONNECT_FAILED');
      this.hubspotConnection = null;
      this.hubspotForm = { token: '', blogId: '', authorId: '' };
      this.hubspotBlogs = [];
      this.hubspotAuthors = [];
      this.hubspotMessage = window.__app.t('hubspot.connect.disconnected');
    } catch (e) {
      this.hubspotError = syncErrorText('hubspot', e.message);
    } finally {
      this._setHubspotBusy(null);
    }
  },


  async _startHubspotJob(type, failCode, jobProp) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this[jobProp]) return;
    try {
      this[jobProp] = await startSyncJob(type, bookId, failCode);
    } catch (e) {
      this.hubspotError = syncErrorText('hubspot', e.message);
    }
  },


  startHubspotImport() {
    return this._startHubspotJob('hubspot-import', 'HUBSPOT_IMPORT_FAILED', 'hubspotImportJobId');
  },


  startHubspotReconcile() {
    if (!confirm(window.__app.t('hubspot.action.reconcileConfirm'))) return;
    return this._startHubspotJob('hubspot-reconcile', 'HUBSPOT_RECONCILE_FAILED', 'hubspotReconcileJobId');
  },
};

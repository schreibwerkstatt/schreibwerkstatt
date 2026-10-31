// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { fetchJson } from './_shared.js';
import {
  syncErrorText, postSyncJson, rehydrateSyncJobs, startSyncJob, deleteSyncConnection,
} from './sync-shared.js';

export const blogMethods = {

  // ── Blog-Sync (WordPress) ─────────────────────────────────────────────────
  // Methoden für den Blog-Verbindungs-Tab im BookSettings-Card. Sichtbar nur bei
  // buchtyp === 'blog'. State lebt im Card-Init (blogForm, blogConnection,
  // blogBusy, blogAction, blogMessage, blogError, blogImportJobId,
  // blogPullJobId, blogReconcileJobId). Was HubSpot genauso macht, steht in
  // ./sync-shared.js.

  async loadBlogStatus(bookId = this._selectedBookId()) {
    if (!bookId) return;
    try {
      const data = await fetchJson(`/blog/${bookId}/status`);
      if (!this._isFormBook(bookId)) return;
      this.blogConnection = data.connection || null;
      if (this.blogConnection) {
        this.blogForm.baseUrl       = this.blogConnection.baseUrl || '';
        this.blogForm.username      = this.blogConnection.username || '';
        this.blogForm.defaultStatus = this.blogConnection.defaultStatus || 'draft';
      }
      const jobs = await rehydrateSyncJobs(bookId, ['blog-import', 'blog-pull', 'blog-reconcile']);
      if (!this._isFormBook(bookId)) return;
      [this.blogImportJobId, this.blogPullJobId, this.blogReconcileJobId] = jobs;
    } catch (e) {
      console.error('[blog] Status laden fehlgeschlagen:', e);
    }
  },


  blogStatusOptions() {
    const app = window.__app;
    return [
      { value: 'draft',   label: app.t('blog.status.draft') },
      { value: 'publish', label: app.t('blog.status.publish') },
      { value: 'private', label: app.t('blog.status.private') },
    ];
  },


  blogFormReady() {
    return !!(this.blogForm.baseUrl && this.blogForm.username
              && (this.blogForm.password || this.blogConnection));
  },


  _setBlogBusy(action) {
    this.blogBusy = !!action;
    this.blogAction = action || null;
    if (action) { this.blogMessage = ''; this.blogError = ''; }
  },


  async testBlogConnection() {
    const bookId = this._selectedBookId();
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('test');
    try {
      const data = await postSyncJson(`/blog/${bookId}/test`, {
        baseUrl: this.blogForm.baseUrl.trim(),
        username: this.blogForm.username.trim(),
        password: this.blogForm.password,
      }, 'BLOG_TEST_FAILED');
      this.blogMessage = window.__app.t('blog.connect.testOk', { name: data.name || this.blogForm.username });
    } catch (e) {
      this.blogError = syncErrorText('blog', e.message);
    } finally {
      this._setBlogBusy(null);
    }
  },


  async saveBlogConnection() {
    const bookId = this._selectedBookId();
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('save');
    try {
      const body = {
        baseUrl: this.blogForm.baseUrl.trim(),
        username: this.blogForm.username.trim(),
        defaultStatus: this.blogForm.defaultStatus || 'draft',
      };
      if (this.blogForm.password) body.password = this.blogForm.password;
      else if (this.blogConnection) body.password = '__keep__';
      const data = await postSyncJson(`/blog/${bookId}/connect`, body, 'BLOG_SAVE_FAILED');
      this.blogConnection = data.connection;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t(data.connection?.targetChanged ? 'blog.connect.targetChanged' : 'blog.connect.saved');
      // Links/Import-Stand verworfen → Badges im Buchorganizer neu laden.
      if (data.connection?.targetChanged) window.__blogCard?.loadLinks?.();
    } catch (e) {
      this.blogError = syncErrorText('blog', e.message);
    } finally {
      this._setBlogBusy(null);
    }
  },


  async disconnectBlog() {
    const bookId = this._selectedBookId();
    if (!bookId) return;
    if (!await window.__app.appConfirm({ message: window.__app.t('blog.connect.disconnectConfirm'), danger: true })) return;
    this._setBlogBusy('disconnect');
    try {
      await deleteSyncConnection('/blog', bookId, 'BLOG_DISCONNECT_FAILED');
      this.blogConnection = null;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t('blog.connect.disconnected');
    } catch (e) {
      this.blogError = syncErrorText('blog', e.message);
    } finally {
      this._setBlogBusy(null);
    }
  },


  async _startBlogJob(type, failCode, jobProp) {
    const bookId = this._selectedBookId();
    if (!bookId || this[jobProp]) return;
    try {
      this[jobProp] = await startSyncJob(type, bookId, failCode);
    } catch (e) {
      this.blogError = syncErrorText('blog', e.message);
    }
  },


  startBlogImport() {
    return this._startBlogJob('blog-import', 'BLOG_IMPORT_FAILED', 'blogImportJobId');
  },


  startBlogPull() {
    return this._startBlogJob('blog-pull', 'BLOG_PULL_FAILED', 'blogPullJobId');
  },


  async startBlogReconcile() {
    if (!await window.__app.appConfirm({ message: window.__app.t('blog.action.reconcileConfirm') })) return;
    return this._startBlogJob('blog-reconcile', 'BLOG_RECONCILE_FAILED', 'blogReconcileJobId');
  },
};

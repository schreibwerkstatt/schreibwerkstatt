// AdminParseFailsCard-Methods. Wird im adminParseFailsCard-Alpine-Scope
// gespreaded. Root-Zugriffe via window.__app. Liest aus
// /admin/parse-fails/{files,file} + DELETE.

import { fmtDateTime, fetchJson, sendJson, fmtBytes } from '../utils.js';
import { tFetchError } from '../i18n.js';

export const adminParseFailsMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async parseFailsEnter() {
    if (this.parseFailsInitialized) return;
    this.parseFailsInitialized = true;
    await this._parseFailsLoadFiles();
  },

  _parseFailsLeave() { /* nichts zu raeumen */ },

  // ── Laden ────────────────────────────────────────────────────────────────
  async _parseFailsLoadFiles() {
    this.parseFailsLoading = true;
    this.parseFailsError = '';
    try {
      const data = await fetchJson('/admin/parse-fails/files');
      this.parseFailsFiles = data.files || [];
      this.parseFailsContent = {};
      this.parseFailsExpanded = {};
    } catch (e) {
      this.parseFailsError = tFetchError(e);
    } finally {
      this.parseFailsLoading = false;
    }
  },

  parseFailsRefresh() {
    this.parseFailsInitialized = false;
    return this.parseFailsEnter();
  },

  // ── Content anzeigen ─────────────────────────────────────────────────────
  async parseFailsToggle(name) {
    if (this.parseFailsExpanded[name]) {
      this.parseFailsExpanded = { ...this.parseFailsExpanded, [name]: false };
      return;
    }
    if (this.parseFailsContent[name] === undefined) {
      try {
        const data = await fetchJson('/admin/parse-fails/file?name=' + encodeURIComponent(name));
        const txt = data.truncated
          ? data.content + '\n\n[…' + window.__app.t('admin.parseFails.truncated') + ']'
          : data.content;
        this.parseFailsContent = { ...this.parseFailsContent, [name]: txt };
      } catch (e) {
        this.parseFailsError = tFetchError(e);
        return;
      }
    }
    this.parseFailsExpanded = { ...this.parseFailsExpanded, [name]: true };
  },

  // ── Loeschen ─────────────────────────────────────────────────────────────
  async parseFailsDelete(name) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.parseFails.confirmDelete'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson('/admin/parse-fails/file?name=' + encodeURIComponent(name), 'DELETE');
      await this._parseFailsLoadFiles();
    } catch (e) {
      this.parseFailsError = tFetchError(e);
    }
  },

  async parseFailsClearAll() {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.parseFails.confirmClear'),
      confirmLabel: window.__app.t('admin.parseFails.clearAll'),
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson('/admin/parse-fails', 'DELETE');
      await this._parseFailsLoadFiles();
    } catch (e) {
      this.parseFailsError = tFetchError(e);
    }
  },

  // ── Format ───────────────────────────────────────────────────────────────
  parseFailsFmtTs(iso) {
    return fmtDateTime(iso, Alpine.store('shell').uiLocale, { dateStyle: 'medium', timeStyle: 'medium' });
  },

  parseFailsFmtSize(bytes) {
    return fmtBytes(Number(bytes) || 0, Alpine.store('shell').uiLocale);
  },
};

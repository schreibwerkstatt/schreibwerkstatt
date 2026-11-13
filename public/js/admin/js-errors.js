// AdminJsErrorsCard-Methods. Wird im adminJsErrorsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/js-errors/list + DELETE.

import { fmtDateTime, fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';

export const adminJsErrorsMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async jsErrorsEnter() {
    if (this.jsErrorsInitialized) return;
    this.jsErrorsInitialized = true;
    await this._jsErrorsLoad();
  },

  _jsErrorsLeave() { /* nichts zu raeumen */ },

  // ── Laden ────────────────────────────────────────────────────────────────
  async _jsErrorsLoad() {
    this.jsErrorsLoading = true;
    this.jsErrorsError = '';
    try {
      const data = await fetchJson('/admin/js-errors/list');
      this.jsErrorsList = data.errors || [];
      this.jsErrorsExpanded = {};
    } catch (e) {
      this.jsErrorsError = tFetchError(e);
    } finally {
      this.jsErrorsLoading = false;
    }
  },

  jsErrorsRefresh() {
    this.jsErrorsInitialized = false;
    return this.jsErrorsEnter();
  },

  jsErrorsToggle(id) {
    this.jsErrorsExpanded = { ...this.jsErrorsExpanded, [id]: !this.jsErrorsExpanded[id] };
  },

  // ── Loeschen ─────────────────────────────────────────────────────────────
  async jsErrorsDelete(id) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.jsErrors.confirmDelete'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson('/admin/js-errors/' + encodeURIComponent(id), 'DELETE');
      await this._jsErrorsLoad();
    } catch (e) {
      this.jsErrorsError = tFetchError(e);
    }
  },

  async jsErrorsClearAll() {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.jsErrors.confirmClear'),
      confirmLabel: window.__app.t('admin.jsErrors.clearAll'),
      danger: true,
    });
    if (!ok) return;
    try {
      await sendJson('/admin/js-errors', 'DELETE');
      await this._jsErrorsLoad();
    } catch (e) {
      this.jsErrorsError = tFetchError(e);
    }
  },

  // ── Format ───────────────────────────────────────────────────────────────
  jsErrorsFmtTs(iso) {
    return fmtDateTime(iso, Alpine.store('shell').uiLocale, { dateStyle: 'medium', timeStyle: 'medium' });
  },

  // Quelle kompakt: nur Dateiname + Zeile (voller Pfad steht im Detail).
  jsErrorsLoc(e) {
    if (!e || !e.source) return '';
    let name = e.source;
    try { name = new URL(e.source).pathname.split('/').pop() || e.source; } catch { /* keep */ }
    return e.line ? `${name}:${e.line}` : name;
  },
};

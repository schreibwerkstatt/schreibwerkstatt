// AdminJsErrorsCard-Methods. Wird im adminJsErrorsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/js-errors/list + DELETE.
// Die Liste traegt bis zu 500 Eintraege: sie rendert schrittweise
// (listWindowed), Details (Stack, URL, User-Agent) haengen per x-if nur an
// aufgeklappten Zeilen.

import { fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { listWindowState } from '../list-window.js';
import { adminLoaderMethods, assignIfChanged } from './admin-loader.js';
import { adminFormatMethods } from './admin-format.js';

export const adminJsErrorsMethods = {
  // ── Lifecycle: jsErrorsEnter / jsErrorsRefresh / _jsErrorsLoad ──────────
  ...adminLoaderMethods('jsErrors', {
    request: () => fetchJson('/admin/js-errors/list'),
    apply(data, { silent }) {
      assignIfChanged(this, 'jsErrorsList', data.errors || [], silent);
      if (!silent) {
        this.jsErrorsExpanded = {};
        Object.assign(this, listWindowState());
      }
    },
  }),

  _jsErrorsLeave() { /* nichts zu raeumen */ },

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
      this.jsErrorsList = this.jsErrorsList.filter(e => e.id !== id);
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
  ...adminFormatMethods,

  // Quelle kompakt: nur Dateiname + Zeile (voller Pfad steht im Detail).
  jsErrorsLoc(e) {
    if (!e || !e.source) return '';
    let name = e.source;
    try { name = new URL(e.source).pathname.split('/').pop() || e.source; } catch { /* keep */ }
    return e.line ? `${name}:${e.line}` : name;
  },
};

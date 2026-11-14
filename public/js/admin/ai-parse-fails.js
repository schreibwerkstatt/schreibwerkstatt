// AdminParseFailsCard-Methods. Wird im adminParseFailsCard-Alpine-Scope
// gespreaded. Root-Zugriffe via window.__app. Liest aus
// /admin/parse-fails/{files,file} + DELETE.

import { fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { adminLoaderMethods, assignIfChanged } from './admin-loader.js';
import { adminFormatMethods } from './admin-format.js';

export const adminParseFailsMethods = {
  // ── Lifecycle: parseFailsEnter / parseFailsRefresh / _parseFailsLoad ────
  ...adminLoaderMethods('parseFails', {
    request: () => fetchJson('/admin/parse-fails/files'),
    apply(data, { silent }) {
      assignIfChanged(this, 'parseFailsFiles', data.files || [], silent);
      if (!silent) {
        this.parseFailsContent = {};
        this.parseFailsExpanded = {};
      }
    },
  }),

  _parseFailsLeave() { /* nichts zu raeumen */ },

  // ── Content anzeigen ─────────────────────────────────────────────────────
  // Der Dump wird beim ersten Aufklappen geholt; solange er laedt, steht die
  // Zeile in `parseFailsDetailLoading` (Knopf gesperrt, Doppelklick laedt nicht
  // doppelt).
  async parseFailsToggle(name) {
    if (this.parseFailsDetailLoading[name]) return;
    if (this.parseFailsExpanded[name]) {
      this.parseFailsExpanded = { ...this.parseFailsExpanded, [name]: false };
      return;
    }
    if (this.parseFailsContent[name] === undefined) {
      this.parseFailsDetailLoading = { ...this.parseFailsDetailLoading, [name]: true };
      try {
        const data = await fetchJson('/admin/parse-fails/file?name=' + encodeURIComponent(name));
        const txt = data.truncated
          ? data.content + '\n\n[…' + window.__app.t('admin.parseFails.truncated') + ']'
          : data.content;
        this.parseFailsContent = { ...this.parseFailsContent, [name]: txt };
        this.parseFailsError = '';
      } catch (e) {
        this.parseFailsError = tFetchError(e);
        return;
      } finally {
        const { [name]: _done, ...rest } = this.parseFailsDetailLoading;
        this.parseFailsDetailLoading = rest;
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
      this.parseFailsFiles = this.parseFailsFiles.filter(f => f.name !== name);
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
      await this._parseFailsLoad();
    } catch (e) {
      this.parseFailsError = tFetchError(e);
    }
  },

  ...adminFormatMethods,
};

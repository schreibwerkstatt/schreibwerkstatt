import { EVT } from '../events.js';
import { downloadBlob } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { isChapterItem } from './tree/chapter-items.js';

// Download-Antworten laufen nicht über fetchJson (Blob statt JSON); ein Fehler
// trägt dieselben Felder (status/code/body), damit tFetchError ihn übersetzt.
async function _responseError(r) {
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, code: body?.error_code || null, body });
}
// Buch/Kapitel/Seite-Export. Methoden in Alpine.data('exportCard') gespreadet;
// Root-Zugriffe via window.__app.

export const exportMethods = {
  async bookExport(fmt) {
    const ref = this._exportEntity();
    if (!ref || this.bookExportLoading) return;
    this.bookExportLoading = fmt;
    this.bookExportError = '';
    try {
      const url = `/export/${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.id)}/${encodeURIComponent(fmt)}`;
      const r = await fetch(url);
      if (!r.ok) throw await _responseError(r);
      await this._downloadResponse(r, `${ref.scope}.${fmt}`);
    } catch (e) {
      this.bookExportError = tFetchError(e);
    } finally {
      this.bookExportLoading = null;
    }
  },

  // Buch-Migration: ganzes Buch als `.swbook`-Bundle (ZIP) fuer Umzug auf eine
  // andere Instanz. Reiner book-scope (kein Kapitel/Seite). Re-Import via
  // folder-import-Card (Modus „Schreibwerkstatt-Buch").
  async migrateExport() {
    const app = window.__app;
    const bid = Alpine.store('nav').selectedBookId;
    if (!bid || this.bookExportLoading) return;
    this.bookExportLoading = 'swbook';
    this.bookExportError = '';
    try {
      const qs = new URLSearchParams();
      if (this.migrateAnalysis) qs.set('analysis', '1');
      if (this.migrateLektorat) qs.set('lektorat', '1');
      if (this.migrateChats)    qs.set('chats', '1');
      if (this.migrateResearch) qs.set('research', '1');
      if (this.migrateWerk)     qs.set('werk', '1');
      const suffix = qs.toString() ? `?${qs}` : '';
      const r = await fetch(`/book-migration/${encodeURIComponent(bid)}${suffix}`);
      if (!r.ok) throw await _responseError(r);
      await this._downloadResponse(r, `book-${bid}.swbook`);
    } catch (e) {
      this.bookExportError = tFetchError(e);
    } finally {
      this.bookExportLoading = null;
    }
  },

  async _downloadResponse(r, fallbackName) {
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename="?([^";]+)"?/i.exec(cd);
    const filename = m ? m[1] : fallbackName;
    downloadBlob(await r.blob(), filename);
  },

  _exportEntity() {
    const app = window.__app;
    if (!app) return null;
    const scope = this.exportScope || 'book';
    if (scope === 'page' && this.exportPageId) return { scope: 'page', id: this.exportPageId };
    if (scope === 'chapter' && this.exportChapterId) return { scope: 'chapter', id: this.exportChapterId };
    const bid = Alpine.store('nav').selectedBookId;
    if (bid) return { scope: 'book', id: parseInt(bid) };
    return null;
  },

  exportScopeOptions() {
    const app = window.__app;
    const opts = [{ value: 'book', label: app.t('export.scope.book') }];
    if (this.exportChapterOptions().length) opts.push({ value: 'chapter', label: app.t('export.scope.chapter') });
    if (this.exportPageOptions().length)    opts.push({ value: 'page',    label: app.t('export.scope.page') });
    return opts;
  },

  exportChapterOptions() {
    const app = window.__app;
    if (!app || !Array.isArray(Alpine.store('nav').tree)) return [];
    return Alpine.store('nav').tree
      .filter(c => isChapterItem(c))
      .map(c => ({ value: c.id, label: c.name }));
  },

  exportPageOptions() {
    const app = window.__app;
    if (!app || !Array.isArray(Alpine.store('nav').pages)) return [];
    return Alpine.store('nav').pages.map(p => ({ value: p.id, label: p.name, group: p.chapterName || '' }));
  },

  _handoffToPdfCustom() {
    const app = window.__app;
    if (!app) return;
    let preset = null;
    if (this.exportScope === 'page' && this.exportPageId)
      preset = { kind: 'page', id: this.exportPageId };
    else if (this.exportScope === 'chapter' && this.exportChapterId)
      preset = { kind: 'chapter', id: this.exportChapterId };
    if (preset) {
      app.__exportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_PRESET, { detail: preset }));
    }
    app.togglePdfExportCard();
  },

  _handoffToEpubCustom() {
    const app = window.__app;
    if (!app) return;
    let preset = null;
    if (this.exportScope === 'page' && this.exportPageId)
      preset = { kind: 'page', id: this.exportPageId };
    else if (this.exportScope === 'chapter' && this.exportChapterId)
      preset = { kind: 'chapter', id: this.exportChapterId };
    if (preset) {
      app.__epubExportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_EPUB_PRESET, { detail: preset }));
    }
    app.toggleEpubExportCard();
  },

  _handoffToDocxCustom() {
    const app = window.__app;
    if (!app) return;
    let preset = null;
    if (this.exportScope === 'page' && this.exportPageId)
      preset = { kind: 'page', id: this.exportPageId };
    else if (this.exportScope === 'chapter' && this.exportChapterId)
      preset = { kind: 'chapter', id: this.exportChapterId };
    if (preset) {
      app.__docxExportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_DOCX_PRESET, { detail: preset }));
    }
    app.toggleDocxExportCard();
  },
};

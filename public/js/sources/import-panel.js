// Import-Panel der Quellen-Karte: BibTeX- oder RIS-Datei (Zotero, JabRef,
// Citavi, EndNote …) bzw. eingefügter Text → POST /sources/import. Wird in
// Alpine.data('sourcesCard') gespreadet; das Parsen macht der Server
// (lib/bib-parse.js), die Dubletten-Erkennung ebenfalls (Zitierschlüssel bzw.
// Gattung + Titel + Jahr in der eigenen Bibliothek).
//
// Was schon in der Bibliothek liegt, wird nicht doppelt angelegt, sondern nur
// diesem Buch zugeordnet — das Ergebnis meldet das getrennt.

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';

// Deckel wie der Server (routes/sources.js#IMPORT_MAX_CHARS): vorab prüfen,
// statt 4 MB hochzuladen und dann abgewiesen zu werden.
const MAX_CHARS = 2_000_000;

function _bookId() {
  return window.Alpine?.store('nav')?.selectedBookId || null;
}

/** Format aus Dateiendung, sonst aus dem Inhalt. null = unklar. */
export function guessBibFormat(filename, text) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex';
  if (ext === 'ris') return 'ris';
  const head = String(text || '').replace(/^﻿/, '').trimStart();
  if (head.startsWith('@')) return 'bibtex';
  if (/^TY {1,2}-/m.test(head.slice(0, 2000))) return 'ris';
  return null;
}

export const sourcesImportMethods = {
  toggleSourceImport() {
    if (this.srcImportOpen) { this.closeSourceImport(); return; }
    this.cancelSourceEdit();
    this.closeSourceCitations();
    this.closeSourcePicker();
    this.closeSourceDetect();
    this.closeSourceExport();
    this.srcImportText = '';
    this.srcImportFileName = '';
    this.srcImportFormat = 'bibtex';
    this.srcImportResult = null;
    this.srcImportError = '';
    this.srcImportOpen = true;
  },

  closeSourceImport() {
    this.srcImportOpen = false;
    this.srcImportText = '';
    this.srcImportResult = null;
    this.srcImportError = '';
  },

  srcImportFormatOptions() {
    const t = window.__app.t.bind(window.__app);
    return [
      { value: 'bibtex', label: t('sources.import.format.bibtex') },
      { value: 'ris', label: t('sources.import.format.ris') },
    ];
  },

  pickSourceImportFile() {
    this.$refs.srcImportInput?.click();
  },

  async readSourceImportFile(evt) {
    const input = evt?.target || null;
    const file = input?.files?.[0];
    if (input) input.value = ''; // dieselbe Datei erneut wählbar
    if (!file) return;
    this.srcImportError = '';
    this.srcImportResult = null;
    if (file.size > MAX_CHARS * 2) {
      this.srcImportError = window.__app.t('error.IMPORT_TOO_LARGE');
      return;
    }
    const text = await file.text();
    this.srcImportText = text;
    this.srcImportFileName = file.name;
    this.srcImportFormat = guessBibFormat(file.name, text) || this.srcImportFormat;
  },

  canRunSourceImport() {
    return !this.srcImportBusy && !!this.srcImportText.trim() && !!_bookId();
  },

  async runSourceImport() {
    const bookId = _bookId();
    if (!this.canRunSourceImport()) return;
    const app = window.__app;
    this.srcImportError = '';
    this.srcImportResult = null;
    if (this.srcImportText.length > MAX_CHARS) {
      this.srcImportError = app.t('error.IMPORT_TOO_LARGE');
      return;
    }
    this.srcImportBusy = true;
    try {
      const res = await fetchJson('/sources/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, format: this.srcImportFormat, text: this.srcImportText }),
      });
      this.srcImportResult = res;
      await this.loadSources();
      this.loadSourceTags();
    } catch (e) {
      this.srcImportError = tFetchError(e);
    } finally {
      this.srcImportBusy = false;
    }
  },

  /** Zusammenfassung des Ergebnisses: neu / schon in der Bibliothek / Fehler. */
  srcImportSummary() {
    const r = this.srcImportResult;
    if (!r) return '';
    return window.__app.t('sources.import.summary', {
      total: r.total || 0, imported: r.imported || 0, skipped: r.skipped || 0,
      linked: r.linked || 0, errors: (r.errors || []).length,
    });
  },

  srcImportErrorText(err) {
    const app = window.__app;
    const key = 'error.' + err.error_code;
    let msg = app.t(key, err.params || {});
    if (msg === key) msg = app.t('error.IMPORT_ENTRY_FAILED');
    return app.t('sources.import.entryError', {
      n: (err.index ?? 0) + 1,
      label: err.label || '—',
      msg,
    });
  },
};

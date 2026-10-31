// Export-Panel der Quellen-Karte: Auswahl (Buecher, Schlagworte, nur belegte)
// → Format → Kopieren oder Herunterladen. Wird in Alpine.data('sourcesCard')
// gespreadet; das Formatieren selbst ist pure in ./export.js.
//
// Die Auswahl reicht bewusst ueber DIESES Buch hinaus: ein Verzeichnis fuer
// einen Kurs setzt sich oft aus mehreren Arbeiten zusammen, oder aus einem
// Schlagwort quer durch die Bibliothek. Darum:
//   Buecher gewaehlt  → Vereinigung der Quellenlisten dieser Buecher
//                       (GET /sources?book_id=, Buch-ACL ab 'viewer' — auch
//                       Quellen eines Co-Autors, die dort zugeordnet sind)
//   keine Buecher     → die ganze eigene Bibliothek (GET /sources/pool)
// Danach filtern Schlagworte (eines genuegt) und „nur belegte" clientseitig.
// „Nur belegte" ist buch-skopiert (cite_count der Buchliste) und gilt darum
// nur mit gewaehlten Buechern.

import { fetchJson } from '../utils.js';
import { CITATION_STYLES } from './format.js';
import { exportSources, exportFileMeta, EXPORT_FORMATS, STYLED_FORMATS } from './export.js';
import { hasAnyTag } from './fields.js';
import { compareText } from '../i18n.js';

function _bookId() {
  return window.Alpine?.store('nav')?.selectedBookId || null;
}

function _slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40);
}

export const sourcesExportMethods = {
  async toggleSourceExport() {
    if (this.srcExportOpen) { this.closeSourceExport(); return; }
    this.cancelSourceEdit();
    this.closeSourceCitations();
    this.closeSourcePicker();
    this.closeSourceDetect();
    this.closeSourceImport();
    const app = window.__app;
    const bookId = _bookId();
    this.srcExportBooks = bookId ? [String(bookId)] : [];
    this.srcExportTags = [];
    this.srcExportCitedOnly = false;
    this.srcExportArchived = false;
    this.srcExportStyle = app?.citationStyleForCurrentBook || 'apa7';
    this.srcExportLang = app?.citationLangForCurrentBook || 'de';
    this.srcExportOpen = true;
    this.loadSourceTags();
    await this.loadSourceExportRows();
  },

  closeSourceExport() {
    this.srcExportOpen = false;
    this.srcExportRows = [];
    this.srcExportError = '';
    this._srcExportSeq++;
  },

  /** Rohliste gemaess Buchauswahl laden. Die Reihenfolge der Antworten ist
   *  egal (Vereinigung ueber die id), aber eine ueberholte Auswahl darf das
   *  Ergebnis einer neueren nicht ueberschreiben — daher die Sequenznummer. */
  async loadSourceExportRows() {
    const seq = ++this._srcExportSeq;
    const books = [...this.srcExportBooks];
    this.srcExportLoading = true;
    this.srcExportError = '';
    try {
      let rows;
      if (books.length === 0) {
        const pool = await fetchJson('/sources/pool?archived=1');
        rows = Array.isArray(pool) ? pool : [];
      } else {
        const lists = await Promise.all(books.map(id =>
          fetchJson(`/sources?book_id=${encodeURIComponent(id)}&archived=1`)));
        const byId = new Map();
        for (const list of lists) {
          for (const s of Array.isArray(list) ? list : []) {
            const prev = byId.get(s.id);
            // Belegt ist eine Quelle, wenn sie in IRGENDEINEM gewaehlten Buch
            // belegt ist — die Kennzahl kommt pro Buch und wird summiert.
            byId.set(s.id, prev ? { ...prev, cite_count: (prev.cite_count || 0) + (s.cite_count || 0) } : s);
          }
        }
        rows = [...byId.values()];
      }
      if (seq !== this._srcExportSeq) return;
      this.srcExportRows = rows;
    } catch (e) {
      if (seq !== this._srcExportSeq) return;
      this.srcExportRows = [];
      this.srcExportError = window.__app.t('sources.export.loadError');
      console.error('[sources] Export-Auswahl laden fehlgeschlagen:', e);
    } finally {
      if (seq === this._srcExportSeq) this.srcExportLoading = false;
    }
  },

  /** Auswahl nach Schlagworten, Archiv und „nur belegte" gefiltert. */
  srcExportSelection() {
    return this._memo('exportSel', [
      this.srcExportRows, this.srcExportTags, this.srcExportCitedOnly,
      this.srcExportArchived, this.srcExportBooks.length,
    ], () => this.srcExportRows.filter(s =>
      (this.srcExportArchived || !s.archived)
      && hasAnyTag(s, this.srcExportTags)
      && (!this.srcExportCitedOnly || this.srcExportBooks.length === 0 || (s.cite_count || 0) > 0)));
  },

  /** Ergebnis im gewaehlten Format — { text, html, count, skipped }. */
  srcExportResult() {
    return this._memo('exportOut', [
      this.srcExportSelection(), this.srcExportFormat, this.srcExportStyle, this.srcExportLang,
    ], () => exportSources(this.srcExportSelection(), {
      format: this.srcExportFormat,
      style: this.srcExportStyle,
      lang: this.srcExportLang,
    }));
  },

  srcExportIsStyled() {
    return STYLED_FORMATS.has(this.srcExportFormat);
  },

  srcExportFormatOptions() {
    return EXPORT_FORMATS.map(f => ({ value: f, label: window.__app.t(`sources.export.format.${f}`) }));
  },

  srcExportStyleOptions() {
    return CITATION_STYLES.map(s => ({ value: s, label: window.__app.t(`sources.style.${s}`) }));
  },

  srcExportLangOptions() {
    return ['de', 'en'].map(l => ({ value: l, label: window.__app.t(`sources.export.lang.${l}`) }));
  },

  srcExportBookOptions() {
    return (window.Alpine?.store('nav')?.books || [])
      .map(b => ({ value: String(b.id), label: b.name }));
  },

  srcExportTagOptions() {
    // Die Filteroptionen folgen der geladenen Rohliste: ein Schlagwort, das in
    // der Buchauswahl nicht vorkommt, liefert garantiert nichts.
    const seen = new Map();
    for (const s of this.srcExportRows) {
      for (const t of s.tags || []) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    for (const t of this.srcExportTags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()]
      .sort(compareText)
      .map(t => ({ value: t, label: t }));
  },

  srcExportBookChips() {
    const names = new Map(this.srcExportBookOptions().map(o => [o.value, o.label]));
    return this.srcExportBooks.map(id => ({ id, label: names.get(id) || `#${id}` }));
  },

  removeSrcExportBook(id) {
    this.srcExportBooks = this.srcExportBooks.filter(b => b !== id);
    this.loadSourceExportRows();
  },

  removeSrcExportTag(tag) {
    this.srcExportTags = this.srcExportTags.filter(t => t !== tag);
  },

  /** Hinweiszeile unter der Vorschau: Anzahl und was fehlt. */
  srcExportSummary() {
    const r = this.srcExportResult();
    const t = window.__app.t;
    if (r.skipped > 0) return t('sources.export.summarySkipped', { n: r.count, skipped: r.skipped });
    return t('sources.export.summary', { n: r.count });
  },

  downloadSourceExport() {
    const r = this.srcExportResult();
    if (!r.count) return;
    const meta = exportFileMeta(this.srcExportFormat);
    const chips = this.srcExportBookChips();
    const base = this.srcExportTags.length
      ? this.srcExportTags.join('-')
      : (chips.length === 1 ? chips[0].label : window.__app.t('sources.export.fileBase'));
    const filename = `${_slug(base) || 'quellen'}.${meta.ext}`;
    const blob = new Blob([r.text], { type: `${meta.mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
};

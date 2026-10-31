// Alpine.data('epubExportCard') — EPUB-Export-Konfiguration + Trigger.
//
// State: Scope-Auswahl (Buch/Kapitel/Seite), EPUB-Reflow-Settings aus
// book_publication (css-Style/Blocksatz/Inhalts-Titel) + Job-Status.
// `showEpubExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Cover/Titelei/Autor-Bio bleiben buch-weit im BookSettings → Publikation-Tab
// (SSoT book_publication); diese Karte spiegelt nur die EPUB-spezifischen
// Reflow-Toggles, schreibt aber denselben /publication-Endpunkt — daher wird
// die volle Meta geladen und vollständig zurückgeschrieben (sonst würde der
// strikte Upsert isbn/subtitle/… auf Defaults zurücksetzen).
//
// Render-Job läuft über die Standard-Job-Queue (/jobs/epub-export). Sobald done,
// wird die EPUB-Datei via /jobs/epub-export/:id/file als Download geholt.
// Scope-Auswahl, Job-Polling/Download und Kapitel-Chips kommen aus
// export-card-base.js (geteilt mit PDF + DOCX).

import { EVT } from '../events.js';
import { headingStyleSlice } from './export-heading-style.js';
import { exportScopeSlice, exportJobSlice, unnumberedChipsSlice, exportSnapshotSlice } from './export-card-base.js';
import { isSelectedBook, loadToken } from './book-guard.js';

const _EMPTY_META = () => ({
  author_name: '',
  isbn: '', subtitle: '', year: '', dedication: '', imprint: '', copyright: '',
  frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_justify: true,
  epub_toc_title: '', description: '', publisher: '', series: '', series_index: '',
  keywords: '', has_cover: false, has_author_image: false,
  // Erweiterte EPUB-Optionen.
  epub_font_size: 'normal', epub_line_height: 'normal', epub_paragraph_style: 'indent',
  epub_indent_size: 'medium', epub_hyphenation: false, epub_chapter_pagebreak: true,
  epub_drop_caps: false, epub_nest_pages_in_toc: true, epub_scene_separator: 'line',
  epub_titlepage_mode: 'generated', epub_chapter_numbering: 'none',
  epub_chapter_numbering_mode: 'nested', epub_unnumbered_chapter_ids: [],
  epub_rights: '', epub_pubdate: '',
  epub_translator: '', epub_illustrator: '', epub_editor_name: '', epub_uuid: '',
  // Pendants zu PDF-Profil-Optionen (Migration 179).
  epub_imprint_position: 'front', epub_chapter_title_style: 'centered-large',
  epub_heading_font: 'match', epub_heading_scale: 'normal', epub_cover_fit: 'contain',
  epub_numerals: 'default', epub_toc_depth: 2, epub_msg_style: 'plain',
  epub_subchapter_pagebreak: false, epub_chapter_rule: false, epub_page_rule: false,
  epub_toc_enabled: true, epub_chapter_number_divider: true,
});

export function registerEpubExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('epubExportCard', () => ({
    ...exportScopeSlice(),
    ...exportSnapshotSlice(),
    ...headingStyleSlice(),
    ...exportJobSlice({
      jobPath: '/jobs/epub-export',
      defaultFilename: 'book.epub',
      i18nPrefix: 'epubExport',
      errorFor: (self, d) => window.__app.tError(d) || window.__app.t('epubExport.error.startFailed'),
      // epubcheck non-fatal: lief der Validator und meldet er Fehler, Warnung
      // zeigen (Datei wird trotzdem geliefert), sonst Standard-Done.
      resolveDone: (self, result) => {
        const checkWarn = result.epubcheck?.validatorAvailable && !result.epubcheck.passed;
        return { statusKey: checkWarn ? 'epubExport.checkWarning' : 'epubExport.done', ttl: checkWarn ? 8000 : 3500 };
      },
    }),
    ...unnumberedChipsSlice({
      getIds: (s) => s.pub?.epub_unnumbered_chapter_ids || [],
      setIds: (s, arr) => { s.pub.epub_unnumbered_chapter_ids = arr; },
    }),

    activeTab: 'typography',

    pub: _EMPTY_META(),
    pubLoaded: false,
    // Buch, zu dem `pub` gehört: savePublication schreibt nur dorthin zurück
    // (Full-Replace-PUT — die Meta eines anderen Buchs wäre ein Datenverlust).
    _pubBookId: null,
    _pubLoadSeq: 0,

    saving: false,
    savedAt: null,
    _savedAtTimer: null,
    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showEpubExportCard, async (visible) => {
        if (!visible) return;
        // Bei jedem Öffnen das Neueste aus /publication ziehen — book_publication
        // ist SSoT (im BookSettings-Publikation-Tab gepflegt); diese Karte hält
        // keinen eigenen Cache. Ein stale `pub` würde beim Full-Replace-Save
        // (savePublication) die dort gepflegte Titelei (Impressum, Widmung, …)
        // mit veralteten Werten überschreiben.
        await this.loadPublication();
        this._ensureExportPicked();
        await this._loadExportSnapshots();
      });
      this._initScopeWatches();
      this._bindPreset(EVT.EXPORT_EPUB_PRESET, '__epubExportPreset');

      // book:changed: laufenden Export räumen + Publikations-Meta neu laden.
      this._onBookChanged = async () => {
        this._resetExportRun();
        this.pubLoaded = false;
        this._pubBookId = null;
        this.exportSnapshotId = '';
        if (window.__app?.showEpubExportCard) { await this.loadPublication(); await this._loadExportSnapshots(); }
        else { this.exportSnapshots = []; }
      };
      window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);

      this._onViewReset = () => {
        this._resetExportRun();
        if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
        this.pub = _EMPTY_META();
        this.pubLoaded = false;
        this._pubBookId = null;
        this.exportScope = 'book';
        this.exportChapterId = null;
        this.exportPageId = null;
        this.exportSnapshots = [];
        this.exportSnapshotId = '';
        this.activeTab = 'typography';
      };
      window.addEventListener(EVT.VIEW_RESET, this._onViewReset);
    },

    destroy() {
      this._stopPoll();
      if (this._savedAtTimer)      { clearTimeout(this._savedAtTimer);      this._savedAtTimer = null; }
      if (this._exportStatusTimer) { clearTimeout(this._exportStatusTimer); this._exportStatusTimer = null; }
      if (this._onBookChanged)  window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener(EVT.VIEW_RESET,   this._onViewReset);
      this._unbindPreset();
    },

    // ── Publikations-Meta (book_publication, geteilt mit PDF + BookSettings) ──
    async loadPublication() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      const isCurrent = loadToken(this, '_pubLoadSeq', bookId);
      try {
        const r = await fetch(`/publication/${bookId}`);
        if (!r.ok || !isCurrent()) return;
        const pub = await r.json();
        if (!isCurrent()) return;
        this.pub = pub;
        this._pubBookId = bookId;
        this.pubLoaded = true;
      } catch {}
    },

    async savePublication() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      // Nicht speichern, bevor die volle Meta geladen ist — der strikte Full-
      // Replace-Upsert (PUT /publication) wuerde den DB-Stand sonst mit leeren
      // Defaults ueberschreiben (author_name/isbn/Titelei + alle epub_*-Felder).
      // exportEpub ruft uns vor jedem Export auf; schlug loadPublication still
      // fehl oder lief sie nie (Cold-Open), exportieren wir den DB-Stand statt
      // ihn zu loeschen.
      if (!this.pubLoaded || String(this._pubBookId) !== String(bookId)) return;
      this.saving = true;
      this.savedAt = null;
      this.exportError = '';
      try {
        // Volle geladene Meta zurueckschreiben — der strikte Upsert setzt jedes
        // NICHT gesendete Feld auf Default. Spread statt Hand-Liste: validateMeta
        // whitelistet serverseitig (Extra-Keys wie has_cover ignoriert), so dass
        // buch-weite Titelei-Felder (z.B. author_name) erhalten bleiben.
        const p = this.pub || {};
        const r = await fetch(`/publication/${bookId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...p }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          this.exportError = window.__app.tError(d) || window.__app.t('epubExport.error.saveFailed');
          return;
        }
        const saved = await r.json();
        if (!isSelectedBook(bookId)) return;
        this.pub = saved;
        this.savedAt = Date.now();
        if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
        this._savedAtTimer = setTimeout(() => { this.savedAt = null; this._savedAtTimer = null; }, 2500);
      } finally {
        this.saving = false;
      }
    },

    // Reflow-Settings schreiben book_publication → braucht editor+. Viewer
    // dürfen trotzdem exportieren (Export = viewer), nur nicht die Settings ändern.
    canEditPublication() {
      const role = window.__app?.currentBookRole;
      return role === 'editor' || role === 'owner';
    },

    // Generischer Enum→Combobox-Options-Helper: Werte + i18n-Key-Prefix.
    _enumOptions(values, prefix) {
      return values.map(v => ({ value: v, label: window.__app.t(`${prefix}.${v}`) }));
    },
    publicationCssOptions() {
      return this._enumOptions(
        ['serif', 'sans', 'georgia', 'palatino', 'garamond', 'times', 'baskerville', 'helvetica', 'verdana'],
        'epubExport.font',
      );
    },
    fontSizeOptions()       { return this._enumOptions(['small', 'normal', 'large'], 'epubExport.fontSize'); },
    lineHeightOptions()     { return this._enumOptions(['tight', 'normal', 'relaxed'], 'epubExport.lineHeight'); },
    paragraphStyleOptions() { return this._enumOptions(['indent', 'spaced'], 'epubExport.paragraphStyle'); },
    indentSizeOptions()     { return this._enumOptions(['small', 'medium', 'large'], 'epubExport.indentSize'); },
    sceneSeparatorOptions() { return this._enumOptions(['line', 'asterism', 'stars', 'blank', 'fleuron'], 'epubExport.sceneSep'); },
    titlepageModeOptions()  { return this._enumOptions(['generated', 'cover', 'none'], 'epubExport.titlepageMode'); },
    // Kapitel-Numerierung: arabic/roman als literale Beispiele, none/word i18n.
    chapterNumberingOptions() {
      return [
        { value: 'none',   label: window.__app.t('epubExport.numbering.none') },
        { value: 'arabic', label: '1, 2, 3' },
        { value: 'roman',  label: 'I, II, III' },
        { value: 'word',   label: window.__app.t('epubExport.numbering.word') },
      ];
    },
    chapterNumberingModeOptions() { return this._enumOptions(['nested', 'flat'], 'epubExport.numberingMode'); },

    // ── PDF-Pendant-Optionen (Migration 179) ──────────────────────────────
    // Heading-Font: 'match' (wie Fliesstext) + dieselben Familien wie der Body-Font.
    headingFontOptions() {
      return [{ value: 'match', label: window.__app.t('epubExport.headingFont.match') }, ...this.publicationCssOptions()];
    },
    headingScaleOptions()     { return this._enumOptions(['small', 'normal', 'large'], 'epubExport.headingScale'); },
    numeralsOptions()         { return this._enumOptions(['default', 'lining', 'oldstyle'], 'epubExport.numerals'); },
    chapterTitleStyleOptions() { return this._enumOptions(['centered-large', 'left-rule', 'minimal'], 'epubExport.titleStyle'); },
    imprintPositionOptions()  { return this._enumOptions(['front', 'back'], 'epubExport.imprintPosition'); },
    coverFitOptions()         { return this._enumOptions(['contain', 'cover'], 'epubExport.coverFit'); },
    // TOC-Tiefe: numerische Werte (1/2) — combobox vergleicht via String(), Auswahl
    // setzt den rohen Wert zurueck (Number). validateMeta parst beides.
    tocDepthOptions() {
      return [
        { value: 1, label: window.__app.t('epubExport.tocDepth.1') },
        { value: 2, label: window.__app.t('epubExport.tocDepth.2') },
      ];
    },

    // Tab-State (activeTab) lebt über die `tabs`-Komponente im Markup
    // (x-modelable an activeTab gekoppelt) — kein setTab/isTab mehr hier.

    openBookSettings() {
      window.__app?.toggleBookSettingsCard?.();
    },

    // ── Export-Trigger ────────────────────────────────────────────────────
    async exportEpub() {
      // Doppelklick: der zweite Klick käme während des awaited Saves durch und
      // startete einen zweiten Job.
      if (this.exporting || this.saving) return;
      // Settings sind buch-weit und werden serverseitig aus der DB gelesen —
      // vor Export speichern, damit ungespeicherte Änderungen greifen. Nur
      // editor+ darf book_publication schreiben; Viewer exportiert mit DB-Stand.
      if (this.canEditPublication()) {
        await this.savePublication();
        if (this.exportError) return;
      }
      const ref = this._exportEntity();
      if (!ref) { this.exportError = window.__app.t('epubExport.error.startFailed'); return; }
      const snapId = this._exportSnapshotIdForSubmit();
      await this._runExportJob({
        scope: ref.scope,
        entityId: ref.id,
        ...(snapId ? { snapshot_id: snapId } : {}),
        ...(ref.scope === 'chapter' ? { include_subchapters: !!this.exportIncludeSubchapters } : {}),
      });
    },
  }));
}

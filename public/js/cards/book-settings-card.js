// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book/book-settings.js';
import { CITATION_DEFAULTS, XREF_DEFAULTS } from '../book/book-settings/citation.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { EVT } from '../events.js';
import { CARD_REQUEST } from './card-request.js';
import { registerBusySource } from '../app/boot/update-policy.js';
import { DEFAULT_DAILY_GOAL_CHARS } from '../utils.js';

// Platzhalter-Meta bis /publication geladen ist: trägt nur das Template (alle
// gebundenen Felder existieren). Gespeichert wird erst nach dem Laden
// (bookPublicationLoaded), der Server ergänzt fehlende Felder aus dem
// gespeicherten Stand — das Objekt muss darum nicht deckungsgleich mit
// lib/publication-meta.js#defaultMeta sein.
const _EMPTY_PUB_META = () => ({
  author_name: '', author_file_as: '', co_authors: [], extra_sections: [],
  isbn: '', subtitle: '', year: '', dedication: '', imprint: '',
  copyright: '', frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_toc_title: '',
  description: '', zielgruppe: '', vergleichstitel: '', publisher: '', series: '', series_index: '', keywords: '',
  epub_font_size: 'normal', epub_line_height: 'normal', epub_paragraph_style: 'indent',
  epub_indent_size: 'medium', epub_scene_separator: 'line', epub_titlepage_mode: 'generated',
  epub_chapter_numbering: 'none', epub_chapter_numbering_mode: 'nested', epub_unnumbered_chapter_ids: [],
  epub_rights: '', epub_pubdate: '', epub_translator: '', epub_illustrator: '',
  epub_editor_name: '', epub_uuid: '', epub_justify: true, epub_hyphenation: false,
  epub_chapter_pagebreak: true, epub_drop_caps: false, epub_nest_pages_in_toc: true,
  // Pendants zu PDF-Profil-Optionen (Migration 179).
  epub_imprint_position: 'front', epub_chapter_title_style: 'centered-large',
  epub_heading_font: 'match', epub_heading_scale: 'normal', epub_cover_fit: 'contain',
  epub_numerals: 'default', epub_toc_depth: 2,
  epub_subchapter_pagebreak: false, epub_chapter_rule: false, epub_page_rule: false,
  epub_toc_enabled: true,
  has_cover: false, has_author_image: false,
});

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsTab: 'book',
    // Buch, dessen Stand das Formular zeigt (save-paths.js: Buch-Bindung).
    _formBookId: null,
    // Je Speicherpfad der zuletzt geladene/gespeicherte Stand (Ungespeichert-Erkennung).
    _saveBaseline: {},
    // Offene Rückfrage «ungespeicherte Änderungen» (Promise), sonst null.
    _settling: null,
    // Timer der kurzlebigen Meldungen, je Feld (save-paths.js#_flash).
    _flashTimers: {},
    bookSettingsLoaded: false,
    bookSettingsName: '',
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsStilprofil: '',
    stilprofilGenerating: false,
    stilprofilJobId: null,
    stilprofilError: '',
    stilprofilAdopting: false,
    bookSettingsErzaehlperspektive: '',
    bookSettingsErzaehlzeit: '',
    bookSettingsIsFinished: false,
    bookSettingsAllowLektorBookChat: false,
    bookSettingsDailyGoalChars: DEFAULT_DAILY_GOAL_CHARS,
    bookSettingsGoalTargetChars: 0,
    bookSettingsGoalDeadline: '',
    bookSettingsOrteReal: false,
    bookSettingsSchauplatzLand: '',
    bookSettingsZeitlinieReal: false,
    bookSettingsWeltfaktenRealPruefen: false,
    bookSettingsExcludeFromStats: false,
    // Quellen-Tab (Zitierstil + Quellenverzeichnis). Eigener Schreibpfad
    // /booksettings/:id/citation — siehe book/book-settings/citation.js.
    bookCitation: { ...CITATION_DEFAULTS },
    bookXref: { ...XREF_DEFAULTS },
    bookCitationLoaded: false,
    citationSaving: false,
    citationSaved: false,
    citationError: '',
    // Abbildungs-/Tabellen-Nummerierung: eigener Pfad /booksettings/:id/xrefs.
    xrefSaving: false,
    xrefSaved: false,
    xrefError: '',
    // Kontext-Tab, Abschnitt „Recherche": Freitext + Domain-Eingrenzung des
    // Recherche-Chats. Eigener Schreibpfad /booksettings/:id/research — siehe
    // book/book-settings/research.js.
    bookResearchProfile: '',
    bookResearchDomains: '',
    bookResearchLoaded: false,
    researchSaving: false,
    researchSaved: false,
    researchError: '',
    // Reiter «Schule»: normalisierte Form oder null (ausgeschaltet).
    // Eigener Schreibpfad /booksettings/:id/schulsystem — siehe
    // book/book-settings/school.js.
    bookSchulsystem: null,
    schulVorlage: '',
    bookSchulsystemLoaded: false,
    // Handlungsjahr (book_settings.handlungsjahr), im selben Abschnitt und Schreibpfad.
    bookHandlungsjahr: null,
    schulSaving: false,
    schulSaved: false,
    schulError: '',
    // Sharing: Access-Liste + Invite-Form.
    bookAccessList: [],
    bookAccessLoading: false,
    bookAccessError: '',
    shareEmail: '',
    shareRole: 'viewer',
    shareBusy: false,
    shareInviteMessage: '',
    // Kategorie.
    categoryPool: [],
    bookCategoryId: '',
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',
    bookHistoryResetLoading: false,
    bookHistoryResetMessage: '',
    bookHistoryResetError: '',
    bookDeleteLoading: false,
    bookDeleteError: '',
    staleCleanupLoading: false,
    staleCleanupMessage: '',
    staleCleanupError: '',
    // Verwaiste Einträge zusammenführen (Danger-Zone) — siehe book/book-settings/merge.js.
    // Kandidatenlisten karten-lokal: die Entitäten-Karten sind zu den Bucheinstellungen
    // exklusiv und laden ihre Kataloge beim Öffnen selbst. `mergeCandidatesBookId`:
    // Buch, zu dem die geladenen Listen gehören (null = nichts geladen).
    mergeCandidatesBookId: null,
    mergeLoading: false,
    mergeBusy: false,
    mergeMessage: '',
    mergeError: '',
    mergeLists: { figur: [], szene: [], ort: [] },
    mergeSel: { figur: { source: '', target: '' }, szene: { source: '', target: '' }, ort: { source: '', target: '' } },
    // Exposé (Tab «Exposé») — siehe book/book-settings/expose.js. Gespeichert
    // werden nur die KI-Texte + Autorfassung; die Eckdaten kommen live aus
    // diesem Formular, der Klappentext ist bookPublication.description.
    exposeLoaded: false,
    exposeRun: null,
    exposeDraft: null,
    exposeHistory: [],
    exposeNormseiten: 0,
    exposeDirty: false,
    exposeGenerating: false,
    exposeJobId: null,
    exposeError: '',
    exposeSaving: false,
    exposeSaved: false,
    exposeUnchanged: false,
    exposeAdopted: false,
    // Buchreihe (Tab «Reihe») — siehe book/book-settings/series.js. `seriesBookId`:
    // Buch, zu dem der geladene Reihen-State gehört (null = nichts geladen).
    seriesBookId: null,
    seriesLoading: false,
    seriesBusy: false,
    seriesData: null,
    seriesJoinable: [],
    seriesPrequels: [],
    seriesNewName: '',
    seriesNameDraft: '',
    seriesJoinId: '',
    seriesMessage: '',
    seriesError: '',
    carrySourceId: '',
    carryLists: null,
    carrySel: { figuren: [], orte: [], fakten: [] },
    carryLoading: false,
    carryBusy: false,
    carryMessage: '',
    carryError: '',
    // Blog-Sync (WordPress).
    blogConnection: null,
    blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
    blogBusy: false,
    blogAction: null,
    blogMessage: '',
    blogError: '',
    // Hinweis nach Import/Pull: WordPress hat Quellen-Verweise entfernt (KSES
    // ohne `unfiltered_html`), die Belege im Text sind zu Klartext degradiert.
    // Kein Fehler — der Sync lief durch —, aber der User muss es erfahren.
    blogCiteWarning: '',
    blogImportJobId: null,
    blogPullJobId: null,
    blogReconcileJobId: null,
    // HubSpot-Sync (Initial-Import + Create-Draft-Push).
    hubspotConnection: null,
    hubspotForm: { token: '', blogId: '', authorId: '' },
    hubspotBlogs: [],
    hubspotAuthors: [],
    hubspotBusy: false,
    hubspotAction: null,
    hubspotMessage: '',
    hubspotError: '',
    hubspotImportJobId: null,
    hubspotReconcileJobId: null,
    // Publikation (book_publication: Cover/Titelei/Bio, geteilt mit PDF+EPUB).
    bookPublication: _EMPTY_PUB_META(),
    bookPublicationLoaded: false,
    pubSaving: false,
    pubSaved: false,
    pubError: '',
    pubCoverUploading: false,
    pubCoverError: '',
    pubAuthorUploading: false,
    pubAuthorError: '',
    pubPreviewVersion: 0,
    _lifecycle: null,
    _unregisterBusy: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        load: () => this._loadAll(),
        // Ungespeichertes nach dem Schliessen bzw. vor dem Reset des alten
        // Buchs: speichern oder verwerfen (save-paths.js#_settleUnsaved).
        onHide: () => this._settleUnsaved(this._formBookId),
        beforeBookChanged: () => this._settleUnsaved(this._formBookId),
        // Factory, nicht Objekt-Literal: der Reset enthält Objekte, die danach
        // per x-model in-place mutiert werden (blogForm, hubspotForm,
        // bookPublication, bookCitation). Ein einmalig gebautes Literal würde
        // seine Referenzen mit dem Live-State teilen und beim nächsten
        // Buchwechsel die Eingaben des letzten Buchs wieder einschleppen.
        resetState: () => ({
          bookSettingsTab: 'book',
          _formBookId: null,
          _saveBaseline: {},
          bookSettingsLoaded: false,
          bookSettingsError: '',
          bookSettingsStilprofil: '',
          stilprofilGenerating: false,
          stilprofilJobId: null,
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          staleCleanupMessage: '',
          staleCleanupError: '',
          // Merge-Panel: Kandidaten gehören zum alten Buch → verwerfen, nicht
          // weiterschleppen. Factory-Reset, darum frische Objekt-Literale.
          mergeCandidatesBookId: null,
          mergeLoading: false,
          mergeBusy: false,
          mergeMessage: '',
          mergeError: '',
          mergeLists: { figur: [], szene: [], ort: [] },
          mergeSel: { figur: { source: '', target: '' }, szene: { source: '', target: '' }, ort: { source: '', target: '' } },
          // Buchreihe: gehört zum alten Buch → verwerfen (Factory-Reset, frische Literale).
          seriesBookId: null,
          seriesLoading: false,
          seriesBusy: false,
          seriesData: null,
          seriesJoinable: [],
          seriesPrequels: [],
          seriesNewName: '',
          seriesNameDraft: '',
          seriesJoinId: '',
          seriesMessage: '',
          seriesError: '',
          carrySourceId: '',
          carryLists: null,
          carrySel: { figuren: [], orte: [], fakten: [] },
          carryLoading: false,
          carryBusy: false,
          carryMessage: '',
          carryError: '',
          bookAccessList: [],
          bookAccessError: '',
          shareEmail: '',
          shareRole: 'viewer',
          shareInviteMessage: '',
          bookCategoryId: '',
          blogConnection: null,
          blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
          blogBusy: false,
          blogMessage: '',
          blogError: '',
          blogCiteWarning: '',
          blogImportJobId: null,
          blogPullJobId: null,
          blogReconcileJobId: null,
          hubspotConnection: null,
          hubspotForm: { token: '', blogId: '', authorId: '' },
          hubspotBlogs: [],
          hubspotAuthors: [],
          hubspotBusy: false,
          hubspotMessage: '',
          hubspotError: '',
          hubspotImportJobId: null,
          hubspotReconcileJobId: null,
          bookPublication: _EMPTY_PUB_META(),
          bookPublicationLoaded: false,
          exposeLoaded: false,
          exposeRun: null,
          exposeDraft: null,
          exposeHistory: [],
          exposeNormseiten: 0,
          exposeDirty: false,
          exposeGenerating: false,
          exposeJobId: null,
          exposeError: '',
          exposeUnchanged: false,
          exposeAdopted: false,
          pubError: '',
          pubCoverError: '',
          pubAuthorError: '',
          bookCitation: { ...CITATION_DEFAULTS },
          bookXref: { ...XREF_DEFAULTS },
          bookCitationLoaded: false,
          citationError: '',
          xrefError: '',
          // Recherche-Profil gehoert zum ALTEN Buch. Ohne das `Loaded`-Flag hier
          // zurueckzusetzen schriebe der naechste Speichern-Klick dessen Profil
          // auf das neue Buch — derselbe Grund wie bei bookCitationLoaded.
          bookResearchProfile: '',
          bookResearchDomains: '',
          bookResearchLoaded: false,
          researchError: '',
          // Schulsystem: gleicher Grund wie beim Recherche-Profil.
          bookSchulsystem: null,
          schulVorlage: '',
          bookSchulsystemLoaded: false,
          bookHandlungsjahr: null,
          schulError: '',
        }),
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          stilprofilError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          staleCleanupMessage: '',
          staleCleanupError: '',
          mergeMessage: '',
          mergeError: '',
          seriesMessage: '',
          seriesError: '',
          carryMessage: '',
          carryError: '',
          bookAccessError: '',
          shareInviteMessage: '',
          blogMessage: '',
          blogError: '',
          blogCiteWarning: '',
          hubspotMessage: '',
          hubspotError: '',
          citationError: '',
          xrefError: '',
          researchError: '',
          schulError: '',
          exposeError: '',
          pubError: '',
        },
        // Verweis aus einer anderen Karte auf einen bestimmten Reiter
        // (book/book-settings/open-tab.js), Palette, Job-Queue-Sprung.
        tabRequest: { key: CARD_REQUEST.BOOK_SETTINGS_TAB, apply: (tab) => { this.bookSettingsTab = tab; } },
        extraListeners: [
          { type: EVT.JOB_FINISHED, handler: (ev) => this._onJobFinished(ev.detail || {}) },
          {
            // Reload/Tab-Close mit ungespeicherten Änderungen: native Rückfrage
            // (appConfirm geht in beforeunload nicht — der Browser blockt Modals).
            type: 'beforeunload',
            handler: (e) => {
              if (!window.__app?.showBookSettingsCard || !this.bookSettingsDirty()) return;
              e.preventDefault();
              e.returnValue = '';
            },
          },
        ],
      });

      // Ungespeicherte Bucheinstellungen zählen als ungespeicherte Arbeit:
      // ein Pflicht-Update der Shell lädt den Tab dann nicht neu.
      this._unregisterBusy = registerBusySource(() => this.bookSettingsDirty() || this.headerSaving());

      // Ein Reiter, dessen Knopf mit dem Buchtyp verschwindet (Schule, Exposé,
      // Sync), darf nicht aktiv bleiben — sonst stünde sein Panel ohne Reiter da.
      this.$watch(() => [this.bookSettingsBuchtyp, this.bookSettingsTab], () => this._ensureTabAvailable());
    },

    // Alle Stores des Buchs laden. Eine noch offene Rückfrage zum vorigen Stand
    // zuerst abwarten — sonst überschriebe das Laden, was sie gleich speichern soll.
    async _loadAll() {
      if (this._settling) await this._settling;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      this._formBookId = bookId;
      await Promise.all([
        this.loadBookSettings(bookId), this.loadBookAccess(bookId), this.loadBookCategory(bookId),
        this.loadBlogStatus(bookId), this.loadHubspotStatus(bookId), this.loadPublication(bookId),
        this.loadExpose(bookId),
      ]);
      this._ensureTabAvailable();
    },

    _tabAvailable(tab) {
      if (tab === 'school') return this.schulAbschnittSichtbar();
      if (tab === 'expose') return !!this.exposeProfilActive();
      if (tab === 'sync') return this.bookSettingsIsBlog();
      return true;
    },

    _ensureTabAvailable() {
      if (!this.bookSettingsLoaded) return;
      if (!this._tabAvailable(this.bookSettingsTab)) this.bookSettingsTab = 'book';
    },

    // Job-Ende (job:finished). Alle Handler filtern auf das Buch im Formular —
    // ein Lauf eines anderen Buchs gehört nicht in dieses Formular.
    _onJobFinished(detail) {
      const t = detail.type;
      if (t === 'stilprofil') return this.onStilprofilJobFinished(detail);
      if (t === 'expose') return this.onExposeJobFinished(detail);
      if (!this._isFormBook(detail.bookId)) return;
      // Blog-Sync: Status nachladen, lokale Job-IDs nullen. Import/Pull legen
      // Abschnitte + Kapitel an → Sidebar-Tree neu laden.
      if (t === 'blog-import' || t === 'blog-pull' || t === 'blog-push' || t === 'blog-reconcile') {
        this.blogImportJobId = null;
        this.blogPullJobId = null;
        this.blogReconcileJobId = null;
        const degraded = detail.job?.result?.citesDegraded || 0;
        this.blogCiteWarning = degraded
          ? window.__app.t('blog.status.citesDegraded', { n: degraded })
          : '';
        this.loadBlogStatus();
        if (t === 'blog-import' || t === 'blog-pull') window.__app.loadPages?.();
        return;
      }
      if (t === 'hubspot-import' || t === 'hubspot-push' || t === 'hubspot-reconcile') {
        this.hubspotImportJobId = null;
        this.hubspotReconcileJobId = null;
        this.loadHubspotStatus();
        if (t === 'hubspot-import') window.__app.loadPages?.();
      }
    },

    destroy() {
      this._clearFlashTimers();
      this._unregisterBusy?.();
      this._lifecycle?.destroy();
    },

    ...bookSettingsMethods,
  }));
}

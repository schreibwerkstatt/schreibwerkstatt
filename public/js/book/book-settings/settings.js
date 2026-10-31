// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Reiter «Buch» und «Kontext»: book_settings (/booksettings/:id) samt Buchname,
// Stilprofil und Kategorie. Speichern läuft über save-paths.js.
import { EVT, contentRepo, countryOptions, fetchJson } from './_shared.js';
import { DEFAULT_DAILY_GOAL_CHARS } from '../../utils.js';
import { tFetchError } from '../../i18n.js';

export const settingsMethods = {
  async loadBookSettings(bookId = this._selectedBookId()) {
    if (!bookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${bookId}`);
      if (!this._isFormBook(bookId)) return;
      const book = Alpine.store('nav').books.find(b => String(b.id) === String(bookId));
      this.bookSettingsName       = book?.name || '';
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
      this.bookSettingsStilprofil = data.stilprofil || '';
      this.bookSettingsErzaehlperspektive = data.erzaehlperspektive || '';
      this.bookSettingsErzaehlzeit        = data.erzaehlzeit        || '';
      this.bookSettingsIsFinished         = !!data.is_finished;
      this.bookSettingsAllowLektorBookChat = !!data.allow_lektor_book_chat;
      // NULL = nie gesetzt → Default; 0 = bewusst kein Tagesziel → leeres Feld.
      this.bookSettingsDailyGoalChars     = data.daily_goal_chars == null
        ? DEFAULT_DAILY_GOAL_CHARS
        : (Number(data.daily_goal_chars) > 0 ? Number(data.daily_goal_chars) : null);
      this.bookSettingsGoalTargetChars    = data.goal_target_chars != null ? Number(data.goal_target_chars) : 0;
      this.bookSettingsGoalDeadline       = data.goal_deadline || '';
      this.bookSettingsOrteReal           = !!data.orte_real;
      this.bookSettingsSchauplatzLand     = data.schauplatz_land || '';
      this.bookSettingsZeitlinieReal      = !!data.zeitlinie_real;
      this.bookSettingsWeltfaktenRealPruefen = !!data.weltfakten_real_pruefen;
      this.bookSettingsExcludeFromStats   = !!data.exclude_from_stats;
      this.bookSettingsLoaded = true;
      this._markClean('settings');
      // Derselbe Response trägt Zitierstil, Recherche-Profil und Schulsystem
      // (kein zweiter Fetch); gespeichert werden sie über ihre eigenen Pfade.
      this._applyCitationSettings(data);
      this._applyResearchSettings(data);
      this._applySchoolSettings(data);
    } catch (e) {
      // Ohne geladenen Stand bleibt `bookSettingsLoaded` false — saveBookSettings
      // schreibt dann nichts, statt das Formular des vorigen Buchs zu speichern.
      if (this._isFormBook(bookId)) this.bookSettingsError = window.__app.t('book.settings.loadFailed');
      console.error('[book-settings] Laden fehlgeschlagen:', e);
    } finally {
      if (this._isFormBook(bookId)) this.bookSettingsLoading = false;
    }
  },

  // Formularstand des Pfads «settings» — Vergleichsbasis UND Request-Body.
  // `allow_lektor_book_chat` fehlt bewusst: die Freigabe speichert der Reiter
  // «Teilen» sofort (saveLektorBookChat), nur der Owner darf sie setzen.
  _settingsSnapshot() {
    const goal = this.bookSettingsDailyGoalChars;
    return {
      name:              (this.bookSettingsName || '').trim(),
      language:          this.bookSettingsLanguage,
      region:            this.bookSettingsRegion,
      buchtyp:           this.bookSettingsBuchtyp              || null,
      buch_kontext:      this.bookSettingsBuchKontext          || null,
      stilprofil:        this.bookSettingsStilprofil           || null,
      erzaehlperspektive: this.bookSettingsErzaehlperspektive  || null,
      erzaehlzeit:       this.bookSettingsErzaehlzeit          || null,
      is_finished:       this.bookSettingsIsFinished ? 1 : 0,
      // Leeres Feld = kein Tagesziel (0); NULL bliebe «Default».
      daily_goal_chars:  goal === '' || goal == null || !Number.isFinite(Number(goal)) ? 0 : Math.round(Number(goal)),
      // Ziel < 1000 (inkl. 0/leer) = kein Ziel → null. Deadline leer → null.
      goal_target_chars: Number(this.bookSettingsGoalTargetChars) >= 1000 ? Math.round(Number(this.bookSettingsGoalTargetChars)) : null,
      goal_deadline:     this.bookSettingsGoalDeadline || null,
      orte_real:         this.bookSettingsOrteReal ? 1 : 0,
      schauplatz_land:   this.bookSettingsSchauplatzLand || null,
      zeitlinie_real:    this.bookSettingsZeitlinieReal ? 1 : 0,
      weltfakten_real_pruefen: this.bookSettingsWeltfaktenRealPruefen ? 1 : 0,
      exclude_from_stats: this.bookSettingsExcludeFromStats ? 1 : 0,
    };
  },

  async saveBookSettings(bookId = this._formBookId) {
    if (!bookId || !this.bookSettingsLoaded) return false;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    const sent = this._snapKey('settings');
    try {
      const nav = Alpine.store('nav');
      const currentBook = nav.books.find(b => String(b.id) === String(bookId));
      const { name, ...payload } = this._settingsSnapshot();
      if (!name) throw new Error(window.__app.t('book.create.errorEmpty'));
      const renamed = name !== (currentBook?.name || '');
      if (renamed) await contentRepo.updateBook(bookId, { name });
      const r = await fetch(`/booksettings/${bookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data));
      }
      this._settleSave('settings', sent);
      this.bookSettingsSaved = true;
      this._flash('bookSettingsSaved');
      if (this._isSelectedBook(bookId)) this._afterSettingsSaved(payload, currentBook, renamed);
      return true;
    } catch (e) {
      this.bookSettingsError = e.message;
      return false;
    } finally {
      this.bookSettingsSaving = false;
    }
  },

  // Root-State des gewählten Buchs nachziehen. Nur wenn das gespeicherte Buch
  // noch das gewählte ist — die Rückfrage beim Buchwechsel speichert das alte.
  async _afterSettingsSaved(payload, currentBook, renamed) {
    const app = window.__app;
    const buchtypChanged = (currentBook?.buchtyp ?? null) !== payload.buchtyp;
    if (renamed || buchtypChanged) {
      // Buchtyp-Wechsel MUSS den Pagetree neu laden (skipPages: false), weil
      // nur loadPages den sidebarMode (Tagebuch → Kalender, sonst Tree) aus
      // isTagebuch() ableitet. Reiner Rename bleibt metadaten-only.
      await app.loadBooks?.({ skipPages: !buchtypChanged, fresh: true });
    }
    // Header-Donut liest Abschluss + Tagesziel aus Alpine.store('progress').
    const progress = Alpine.store('progress');
    progress.dailyProgressIsFinished = !!payload.is_finished;
    progress.dailyProgressDailyGoalChars = payload.daily_goal_chars;
    // Belege im Editor formatieren in der Buchsprache.
    app.citationLangForCurrentBook = payload.language;
    // Der rohe /booksettings-Stand im geteilten Store ist überholt.
    app.invalidateBookSettingsCache?.();
  },

  // Owner-Freigabe «Lektoren dürfen den Buch-Chat nutzen» — sofort gespeichert
  // (Reiter «Teilen» hat keinen Kopf-Knopf). Der Server übernimmt das Feld nur
  // vom Owner; bei Fehler springt die Checkbox zurück.
  async saveLektorBookChat(value) {
    const bookId = this._formBookId;
    if (!bookId || !this.bookAccessIsOwner()) return;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/booksettings/${bookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_lektor_book_chat: value ? 1 : 0 }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(window.__app.tError(d)); }
      window.__app.invalidateBookSettingsCache?.();
    } catch (e) {
      if (this._isFormBook(bookId)) {
        this.bookSettingsAllowLektorBookChat = !value;
        this.bookAccessError = e.message;
      }
    }
  },


  // Stilprofil aus dem Buch destillieren (KI-Job). Ergebnis wird serverseitig in
  // book_settings.stilprofil persistiert; bei job:finished (Handler in der Karte)
  // wird nur das Stilprofil-Feld aus dem Job-Result übernommen — der Rest des
  // Formulars (ggf. ungespeicherte Edits) bleibt unangetastet.
  async generateStilprofil() {
    const bookId = this._formBookId;
    if (!bookId || this.stilprofilGenerating) return;
    this.stilprofilGenerating = true;
    this.stilprofilError = '';
    try {
      const res = await fetch('/jobs/stilprofil', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Number(bookId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data));
      this.stilprofilJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'stilprofil', jobId: data.jobId } }));
    } catch (e) {
      this.stilprofilGenerating = false;
      this.stilprofilError = e.message;
    }
  },

  // job:finished (Handler in der Karte). Das Profil ist serverseitig schon
  // gespeichert: war der Pfad vorher unverändert, bleibt er es auch danach.
  onStilprofilJobFinished(detail) {
    if (!this._isFormBook(detail?.bookId)) return;
    this.stilprofilGenerating = false;
    this.stilprofilJobId = null;
    const job = detail.job;
    if (job?.status === 'done' && job.result?.stilprofil) {
      const wasClean = !this._isDirty('settings');
      this.bookSettingsStilprofil = job.result.stilprofil;
      if (wasClean) this._markClean('settings');
    } else if (job?.status === 'error') {
      this.stilprofilError = window.__app.t('book.settings.stilprofil.genError');
    }
  },


  // Autorenprofil in dieses Buch übernehmen. Füllt NUR das Formularfeld — der
  // User sieht den Text und speichert selbst. Kein zweiter Schreibpfad auf
  // book_settings.stilprofil, und kein stilles Überschreiben dessen, was im
  // Feld schon steht: der Klick ist die Entscheidung, das Speichern die zweite.
  //
  // Neu angelegte Bücher bekommen den Text bereits bei der Anlage
  // (lib/content-store/index.js) — dieser Knopf ist der Weg für Bücher, die es
  // damals noch nicht gab.
  async adoptAuthorProfile() {
    if (this.stilprofilAdopting) return;
    this.stilprofilAdopting = true;
    this.stilprofilError = '';
    try {
      const data = await fetchJson('/me/author-profile');
      const text = (data?.profile?.profil_text || '').trim();
      if (!text) {
        this.stilprofilError = window.__app.t('book.settings.stilprofil.noAuthorProfile');
        return;
      }
      this.bookSettingsStilprofil = text;
    } catch (e) {
      this.stilprofilError = tFetchError(e);
    } finally {
      this.stilprofilAdopting = false;
    }
  },


  // Kategorie. Pool global; pro Buch eine Kategorie (optional). Speichert sofort
  // bei Auswahl (saveBookCategory), nicht über den Kopf-Knopf.
  async loadBookCategory(bookId = this._selectedBookId()) {
    if (!bookId) return;
    try {
      const [pool, categoryRes] = await Promise.all([
        fetchJson('/local/categories'),
        fetchJson(`/books/${bookId}/category`),
      ]);
      if (!this._isFormBook(bookId)) return;
      this.categoryPool = pool.categories || [];
      this.bookCategoryId = categoryRes.category?.id || '';
    } catch (e) {
      console.error('[book-settings] Kategorie laden fehlgeschlagen:', e);
    }
  },


  bookCategoryOptions() {
    return (this.categoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },


  async saveBookCategory(value) {
    const bookId = this._formBookId;
    if (!bookId) return;
    // value aus combobox-change-Event-Detail; x-modelable-Sync zu bookCategoryId
    // ist beim Dispatch noch nicht propagiert (stale read).
    const raw = value !== undefined ? value : this.bookCategoryId;
    const cid = raw === '' || raw === null || raw === undefined ? null : parseInt(raw, 10);
    try {
      const r = await fetch(`/books/${bookId}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: cid }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data));
      }
      // Eine zuvor gemeldete «Kategorie fehlt» ist mit der Auswahl erledigt.
      if (cid && this.bookSettingsError === window.__app.t('book.category.required')) this.bookSettingsError = '';
      await window.__app.loadBooks({ skipPages: true });
    } catch (e) {
      this.bookSettingsError = e.message;
    }
  },


  /** Gibt die Buchtyp-Liste für die aktuelle Sprache zurück (aus promptConfig). */
  bookSettingsBuchtypen() {
    const lang = this.bookSettingsLanguage || 'de';
    const typen = Alpine.store('shell').promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },


  bookSettingsBuchtypOptions() {
    return this.bookSettingsBuchtypen().map(t => ({ value: t.key, label: t.label }));
  },


  // Gate für den Sync-Reiter: liest den im Formular gewählten Buchtyp (nicht
  // den gespeicherten Nav-Wert), damit der Reiter live auf die Combobox-Auswahl
  // reagiert. SSoT für das 'blog'-Literal im Settings-Scope.
  bookSettingsIsBlog() {
    return this.bookSettingsBuchtyp === 'blog';
  },

  // PDF-/EPUB-Export gibt es für Journalismus nicht (feature-registry
  // `hiddenForBuchtyp`) — die Sprung-Knöpfe im Reiter «Publikation» auch nicht.
  bookSettingsHasBookExport() {
    return this.bookSettingsBuchtyp !== 'journalismus';
  },


  bookSettingsLangOptions() {
    const app = window.__app;
    return [
      { value: 'de', label: app.t('lang.de') },
      { value: 'en', label: app.t('lang.en') },
    ];
  },

  // Region-Optionen werden inline im x-effect gebaut (reaktiv auf
  // bookSettingsLanguage) — Method-Indirection trackt das nicht zuverlässig,
  // siehe DESIGN.md „Reaktivität bei Datenquelle aus Karten-Scope".

  bookSettingsPovOptions() {
    const app = window.__app;
    return [
      { value: 'ich',                label: app.t('book.settings.pov.ich') },
      { value: 'er_sie_personal',    label: app.t('book.settings.pov.er_personal') },
      { value: 'er_sie_auktorial',   label: app.t('book.settings.pov.er_auktorial') },
      { value: 'du',                 label: app.t('book.settings.pov.du') },
      { value: 'wir',                label: app.t('book.settings.pov.wir') },
      { value: 'gemischt',           label: app.t('book.settings.pov.gemischt') },
    ];
  },


  // Haupt-Schauplatzland: ISO-3166-1-alpha-2-Liste, lokalisierte Labels.
  // emptyLabel-Option ('') = „nicht festgelegt", via Combobox-emptyLabel ergänzt.
  bookSettingsLandOptions() {
    const lang = this.bookSettingsLanguage || 'de';
    return countryOptions(lang);
  },


  bookSettingsTempusOptions() {
    const app = window.__app;
    return [
      { value: 'praeteritum', label: app.t('book.settings.tempus.praeteritum') },
      { value: 'praesens',    label: app.t('book.settings.tempus.praesens') },
      { value: 'gemischt',    label: app.t('book.settings.tempus.gemischt') },
    ];
  },
};

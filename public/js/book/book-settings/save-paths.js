// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Speicher-Orchestrierung der Bucheinstellungen: ein Kopf-Knopf, mehrere
// unabhängige Schreibpfade (book_settings, book_publication, Zitierstil,
// Querverweise, Recherche, Schule, Exposé).
//
// SAVE_PATHS ist die EINE Liste dieser Pfade. saveActiveTab, die header*()-
// Anzeigen, die Ungespeichert-Erkennung und die Rückfrage beim Verlassen leiten
// sich daraus ab — ein neuer Pfad bekommt hier eine Zeile, sonst nichts.
//
// Ungespeichert = der Formularstand weicht vom zuletzt geladenen/gespeicherten
// Stand ab (`_saveBaseline`, je Pfad ein normalisierter Schnappschuss).
// Gespeichert werden nur abweichende Pfade: wer nur das Tagesziel ändert,
// schreibt nicht die (womöglich veraltete) Publikation eines anderen Tabs zurück.
//
// Buch-Bindung: `_formBookId` ist das Buch, dessen Stand das Formular zeigt.
// Jeder Loader prüft nach dem `await`, ob es noch dasselbe ist — eine späte
// Antwort für Buch A darf nie im Formular von Buch B landen. Jeder Save bekommt
// die Buch-ID explizit, damit die Rückfrage beim Buchwechsel den Stand des
// ALTEN Buchs noch auf das alte Buch schreiben kann.

export const SAVE_PATHS = Object.freeze([
  { key: 'settings',    save: 'saveBookSettings',     saving: 'bookSettingsSaving', saved: 'bookSettingsSaved', error: 'bookSettingsError', loaded: 'bookSettingsLoaded',     snapshot: '_settingsSnapshot' },
  { key: 'publication', save: 'savePublication',      saving: 'pubSaving',          saved: 'pubSaved',          error: 'pubError',          loaded: 'bookPublicationLoaded',  snapshot: '_publicationSnapshot' },
  { key: 'citation',    save: 'saveCitationSettings', saving: 'citationSaving',     saved: 'citationSaved',     error: 'citationError',     loaded: 'bookCitationLoaded',     snapshot: '_citationSnapshot' },
  { key: 'xref',        save: 'saveXrefSettings',     saving: 'xrefSaving',         saved: 'xrefSaved',         error: 'xrefError',         loaded: 'bookCitationLoaded',     snapshot: '_xrefSnapshot' },
  { key: 'research',    save: 'saveResearchSettings', saving: 'researchSaving',     saved: 'researchSaved',     error: 'researchError',     loaded: 'bookResearchLoaded',     snapshot: '_researchSnapshot' },
  { key: 'school',      save: 'saveSchulsystem',      saving: 'schulSaving',        saved: 'schulSaved',        error: 'schulError',        loaded: 'bookSchulsystemLoaded',  snapshot: '_schoolSnapshot' },
  // Exposé führt seinen Ungespeichert-Zustand selbst (markExposeDirty beim Tippen).
  { key: 'expose',      save: 'saveExpose',           saving: 'exposeSaving',       saved: 'exposeSaved',       error: 'exposeError',       dirty: 'exposeDirty' },
]);

const PATH = Object.fromEntries(SAVE_PATHS.map(p => [p.key, p]));

// Reiter, deren Felder über den Kopf-Knopf gespeichert werden. Die übrigen
// (Teilen, Reihe, Sync, Gefahrenzone) speichern je Aktion sofort — dort wäre
// ein Kopf-Knopf ein Knopf ohne Wirkung.
const HEADER_SAVE_TABS = new Set(['book', 'context', 'school', 'sources', 'publication', 'expose']);

// Normalform für den Vergleich: Formularfelder wechseln je nach Komponente
// zwischen Zahl und String (numInput, x-model), Checkboxen zwischen Boolean
// und 0/1, leere Felder zwischen null und ''. Ohne Normalisierung meldete
// schon das blosse Laden «ungespeichert».
function _norm(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return v.map(_norm);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = _norm(v[k]);
    return o;
  }
  return String(v);
}

export const snapshotKey = (v) => JSON.stringify(_norm(v));

export const savePathMethods = {
  // ── Buch-Bindung ──────────────────────────────────────────────────────────
  _selectedBookId() {
    return Alpine.store('nav').selectedBookId;
  },

  /** Gehört eine Antwort für `bookId` noch ins Formular? */
  _isFormBook(bookId) {
    return !!bookId
      && String(bookId) === String(this._formBookId)
      && String(bookId) === String(this._selectedBookId());
  },

  /** Ist `bookId` das gerade gewählte Buch (Root-State spiegeln erlaubt)? */
  _isSelectedBook(bookId) {
    return !!bookId && String(bookId) === String(this._selectedBookId());
  },

  // ── Ungespeichert-Erkennung ───────────────────────────────────────────────
  _snapKey(key) {
    const p = PATH[key];
    return p.snapshot ? snapshotKey(this[p.snapshot]()) : null;
  },

  /** Aktuellen Stand eines Pfads als gespeichert markieren (nach Laden/Speichern). */
  _markClean(key) {
    this._saveBaseline = { ...this._saveBaseline, [key]: this._snapKey(key) };
  },

  /** Nach einem Save: Antwort nur übernehmen, wenn seit dem Absenden niemand
   *  weitergetippt hat — sonst gälte der gesendete Stand als Basis, und das
   *  Weitergetippte bleibt ungespeichert statt überschrieben zu werden. */
  _settleSave(key, sent, apply) {
    if (this._snapKey(key) === sent) {
      apply?.();
      this._markClean(key);
    } else {
      this._saveBaseline = { ...this._saveBaseline, [key]: sent };
    }
  },

  _isDirty(key) {
    const p = PATH[key];
    if (p.dirty) return !!this[p.dirty];
    if (!this[p.loaded]) return false;
    const base = this._saveBaseline[key];
    return base != null && this._snapKey(key) !== base;
  },

  _dirtyKeys() {
    return SAVE_PATHS.filter(p => this._isDirty(p.key)).map(p => p.key);
  },

  bookSettingsDirty() {
    return SAVE_PATHS.some(p => this._isDirty(p.key));
  },

  _discardUnsaved() {
    for (const p of SAVE_PATHS) {
      if (p.dirty) this[p.dirty] = false;
      else if (this[p.loaded]) this._markClean(p.key);
    }
  },

  // ── Speichern ─────────────────────────────────────────────────────────────
  // Pflichtfelder: Buchtyp immer (alle KI-Jobs ziehen den Genre-Kontext via
  // getBookPrompts), Kategorie nur wenn der globale Pool nicht leer ist (sonst
  // gäbe es nichts auszuwählen → Save-Blockade). Liefert den i18n-Key des
  // ersten verletzten Felds oder null. Sperrt nur den Pfad «settings» — die
  // übrigen Reiter speichern trotzdem.
  _taxonomyError() {
    if (!this.bookSettingsBuchtyp) return 'book.settings.buchtypRequired';
    if ((this.categoryPool || []).length > 0 && !this.bookCategoryId) return 'book.category.required';
    return null;
  },

  async saveActiveTab() {
    if (this.headerDisabled()) return;
    await this._saveDirty(this._formBookId, { jump: true });
  },

  /** Alle ungespeicherten Pfade für `bookId` schreiben. true = alles durch. */
  async _saveDirty(bookId, { jump = false } = {}) {
    if (!bookId) return false;
    let keys = this._dirtyKeys();
    const taxErr = keys.includes('settings') ? this._taxonomyError() : null;
    if (taxErr) {
      keys = keys.filter(k => k !== 'settings');
      if (jump) this.bookSettingsTab = 'book';
    }
    const results = await Promise.all(keys.map(k => this[PATH[k].save](bookId)));
    // Nach den Saves setzen: saveBookSettings läuft hier nicht, aber ein
    // paralleler Pfad darf die Meldung nicht wegräumen.
    if (taxErr) this.bookSettingsError = window.__app.t(taxErr);
    return !taxErr && results.every(r => r !== false);
  },

  // ── Kopfzeile ─────────────────────────────────────────────────────────────
  headerSaving()   { return SAVE_PATHS.some(p => this[p.saving]); },
  headerError()    { return SAVE_PATHS.map(p => this[p.error]).find(Boolean) || ''; },
  headerSaved()    { return SAVE_PATHS.some(p => this[p.saved]) && !this.headerError(); },
  headerDisabled() { return this.headerSaving() || this.bookSettingsLoading || !this.bookSettingsDirty(); },
  headerSaveVisible() { return HEADER_SAVE_TABS.has(this.bookSettingsTab); },

  /** Kurzlebige Meldung/Flag nach `ms` zurücksetzen (ein Timer je Feld). */
  _flash(field, ms = 2500, resetTo = false) {
    if (this._flashTimers[field]) clearTimeout(this._flashTimers[field]);
    this._flashTimers[field] = setTimeout(() => {
      this[field] = resetTo;
      delete this._flashTimers[field];
    }, ms);
  },

  _clearFlashTimers() {
    for (const t of Object.values(this._flashTimers)) clearTimeout(t);
    this._flashTimers = {};
  },

  // ── Verlassen mit ungespeicherten Änderungen ──────────────────────────────
  // Läuft NACH dem Schliessen bzw. beim Buchwechsel, nicht davor: die Wege aus
  // der Karte sind zahlreich (andere Karte, Abschnitt, Hash-Sprung, Home) und
  // synchron. Die Komponente lebt weiter und hält den Stand — «Speichern»
  // schreibt ihn auf das Buch, zu dem er gehört, «Verwerfen» lässt ihn fallen
  // (das nächste Öffnen lädt neu). Ein zweiter Anlass während der offenen
  // Rückfrage (Schliessen + Buchwechsel in einem Zug) wartet auf dieselbe.
  async _settleUnsaved(bookId) {
    if (this._settling) return this._settling;
    if (!bookId || !this.bookSettingsDirty()) return;
    const app = window.__app;
    this._settling = (async () => {
      const save = await app.appConfirm({
        message: app.t('book.settings.unsaved.message'),
        confirmLabel: app.t('common.save'),
        cancelLabel: app.t('book.settings.unsaved.discard'),
      });
      if (save && !await this._saveDirty(bookId)) {
        app.setStatus(app.t('book.settings.unsaved.saveFailed', { msg: this.headerError() }), false, 8000);
      }
      this._discardUnsaved();
    })().finally(() => { this._settling = null; });
    return this._settling;
  },
};

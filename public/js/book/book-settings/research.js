// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Recherche-Profil des Buchs (Kontext-Tab): Freitext-Steuerung + Domain-
// Eingrenzung fuer den Recherche-Chat (docs/recherche-chat.md).
//
// Eigener Schreibpfad `PUT /booksettings/:book_id/research` — Muster von
// /citation und /xrefs. Der Kopf-Knopf der Karte schreibt ihn mit (save-paths.js).
//
// Die Domains bearbeitet der User als Text (eine Zeile pro Domain); normalisiert
// wird ausschliesslich serverseitig (lib/research-profile.js), und die Antwort
// setzt das Feld auf den TATSAECHLICH gespeicherten Stand zurueck. Eine zweite
// Normalisierung im Browser waere eine zweite Wahrheit darueber, was eine gueltige
// Domain ist — und die beiden liefen garantiert auseinander.

export const RESEARCH_PROFILE_MAX = 1500;

// Startpunkte fuer die Domain-Eingrenzung. Reine Eingabehilfe: ein Klick haengt
// die Domains an das Textfeld an, mehr passiert nicht — der Server entscheidet
// weiterhin allein, was davon gespeichert wird. Darum hier und nicht auf dem
// Server: es ist eine Vorschlagsliste, keine Regel.
export const RESEARCH_DOMAIN_PRESETS = Object.freeze([
  { key: 'medizin', domains: ['pubmed.ncbi.nlm.nih.gov', 'europepmc.org', 'cochranelibrary.com', 'who.int'] },
  { key: 'wissenschaft', domains: ['scholar.google.com', 'arxiv.org', 'doaj.org', 'zenodo.org', 'crossref.org'] },
  { key: 'recht', domains: ['fedlex.admin.ch', 'bger.ch', 'eur-lex.europa.eu', 'gesetze-im-internet.de'] },
  { key: 'statistik', domains: ['bfs.admin.ch', 'destatis.de', 'data.worldbank.org', 'ourworldindata.org'] },
  { key: 'geschichte', domains: ['archive.org', 'e-periodica.ch', 'hls-dhs-dss.ch', 'deutsche-digitale-bibliothek.de'] },
]);

export const researchMethods = {
  /** Aus dem Settings-Response uebernehmen. Kein eigener Fetch — loadBookSettings
   *  laedt `/booksettings/:id` und der Response traegt beide Felder. */
  _applyResearchSettings(data) {
    this.bookResearchProfile = data?.research_profile || '';
    this.bookResearchDomains = (data?.research_domains || []).join('\n');
    this.bookResearchLoaded = true;
    this._markClean('research');
  },

  _researchSnapshot() {
    return {
      research_profile: (this.bookResearchProfile || '').trim() || null,
      research_domains: this.bookResearchDomains || '',
    };
  },

  /** Wie viele Domains der Server aus der aktuellen Eingabe voraussichtlich
   *  behaelt — grobe Zeilenzaehlung fuer den Hinweis unter dem Feld. Bewusst
   *  keine Validierung: die macht der Server, und sein Ergebnis steht nach dem
   *  Speichern im Feld. */
  researchDomainCount() {
    return (this.bookResearchDomains || '').split(/[\s,;]+/).filter(Boolean).length;
  },

  /** Preset-Liste fuers Template (Alpine sieht Modul-Konstanten nicht). */
  researchDomainPresets() {
    return RESEARCH_DOMAIN_PRESETS;
  },

  researchPresetLabel(key) {
    return window.__app.t(`book.settings.research.preset.${key}`);
  },

  /** Preset anhaengen statt ersetzen: ein Fachgebiet ist oft nur der Anfang der
   *  Liste, und ein Klick darf keine getippte Domain wegnehmen. Duplikate faellt
   *  spaetestens der Server heraus. */
  applyResearchPreset(key) {
    const preset = RESEARCH_DOMAIN_PRESETS.find(p => p.key === key);
    if (!preset) return;
    const have = (this.bookResearchDomains || '').split(/[\s,;]+/).filter(Boolean);
    const merged = have.concat(preset.domains.filter(d => !have.includes(d)));
    this.bookResearchDomains = merged.join('\n');
  },

  async saveResearchSettings(bookId = this._formBookId) {
    // Nicht speichern, bevor der Stand geladen ist — ein ungeladener Default
    // würde den DB-Stand leeren.
    if (!bookId || !this.bookResearchLoaded) return false;
    this.researchSaving = true;
    this.researchSaved = false;
    this.researchError = '';
    const sent = this._snapKey('research');
    try {
      const r = await fetch(`/booksettings/${bookId}/research`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._researchSnapshot()),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d));
      }
      const data = await r.json();
      // Normalisierten Stand zurückspiegeln: aus einer eingefügten URL wird der
      // Host, eine unbrauchbare Zeile fällt weg. Der User soll das sofort sehen
      // — ausser er hat inzwischen weitergetippt.
      if (this._isFormBook(bookId)) this._settleSave('research', sent, () => this._applyResearchSettings(data));
      this.researchSaved = true;
      this._flash('researchSaved');
      window.__app?.invalidateBookSettingsCache?.();
      return true;
    } catch (e) {
      this.researchError = e.message;
      return false;
    } finally {
      this.researchSaving = false;
    }
  },
};

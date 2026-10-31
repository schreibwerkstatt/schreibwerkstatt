// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Quellen-Tab der Bucheinstellungen: Zitierstil, Quellenverzeichnis und
// Abbildungs-Nummerierung (Grundlage der Querverweise auf Abbildungen).
//
// Eigener Schreibpfad `PUT /booksettings/:book_id/citation` (PATCH-artig) statt
// weiterer Felder im Haupt-Body: der Zitierstil gilt buchweit fuer ALLE
// Ausgabewege (PDF, DOCX, EPUB, WordPress, HubSpot) und gehoert damit weder in
// ein Exportprofil noch in die 18-stellige Positionsliste von saveBookSettings.
//
// Der Kopf-Knopf der Karte schreibt diesen Store mit (save-paths.js).

import { EVT } from './_shared.js';
import { CITATION_STYLES, DEFAULT_STYLE, formatFull } from '../../sources/format.js';

// Beispielquelle der Live-Vorschau. Bewusst ein bekanntes Werk mit allen
// relevanten Feldern (Urheber, Jahr, Titel, Ort, Verlag) — so unterscheiden sich
// die drei Stile in der Vorschau sichtbar voneinander.
const PREVIEW_SOURCE = Object.freeze({
  csl_type: 'book',
  authors: [{ family: 'Kafka', given: 'Franz' }],
  editors: [],
  title: 'Die Verwandlung',
  year: '1915',
  place: 'Leipzig',
  publisher: 'Kurt Wolff',
});

export const XREF_DEFAULTS = Object.freeze({
  figure_numbering: 0,
  table_numbering: 0,
});

/** Beide Nummerierungs-Schalter aus einem Settings-/PUT-Response. */
function _xrefFrom(data) {
  return {
    figure_numbering: data?.figure_numbering ? 1 : 0,
    table_numbering: data?.table_numbering ? 1 : 0,
  };
}

/** Belegdarstellung. Deckungsgleich mit lib/endnotes.js#CITATION_NOTES_MODES und
 *  db/schema.js#VALID_CITATION_NOTES — laeuft es auseinander, verwirft der
 *  Endpunkt den Wert mit 400. */
export const CITATION_NOTES = ['inline', 'endnotes', 'footnotes'];
export const DEFAULT_NOTES = 'inline';

export const CITATION_DEFAULTS = Object.freeze({
  citation_style: DEFAULT_STYLE,
  citation_notes: DEFAULT_NOTES,
  bibliography_enabled: 0,
  bibliography_title: '',
  bibliography_scope: 'cited',
  bibliography_in_blog: 0,
});

/** Zitier-Einstellungen aus einem Settings-/PUT-Response, auf gültige Werte gezwungen. */
function _citationFrom(data) {
  return {
    citation_style: CITATION_STYLES.includes(data?.citation_style)
      ? data.citation_style : DEFAULT_STYLE,
    citation_notes: CITATION_NOTES.includes(data?.citation_notes)
      ? data.citation_notes : DEFAULT_NOTES,
    bibliography_enabled: data?.bibliography_enabled ? 1 : 0,
    bibliography_title: data?.bibliography_title || '',
    bibliography_scope: data?.bibliography_scope === 'all' ? 'all' : 'cited',
    bibliography_in_blog: data?.bibliography_in_blog ? 1 : 0,
  };
}

export const citationMethods = {
  /** Aus dem Settings-Response übernehmen. Kein eigener Fetch — loadBookSettings
   *  lädt `/booksettings/:id` bereits und der Response enthält die
   *  Quellenfelder. */
  _applyCitationSettings(data) {
    this.bookCitation = _citationFrom(data);
    this.bookXref = _xrefFrom(data);
    this.bookCitationLoaded = true;
    this._markClean('citation');
    this._markClean('xref');
  },

  _citationSnapshot() {
    const c = this.bookCitation || {};
    return {
      citation_style: c.citation_style,
      citation_notes: c.citation_notes,
      bibliography_enabled: c.bibliography_enabled ? 1 : 0,
      bibliography_title: (c.bibliography_title || '').trim() || null,
      bibliography_scope: c.bibliography_scope,
      bibliography_in_blog: c.bibliography_in_blog ? 1 : 0,
    };
  },

  _xrefSnapshot() {
    return _xrefFrom(this.bookXref);
  },

  /** Abbildungs- und Tabellen-Nummerierung (je eigener Schalter). Eigener Endpunkt (`PUT /booksettings/:id/xrefs`),
   *  weil es keine Zitier-Einstellung ist — es steht nur im selben Tab, weil
   *  beides zur Fachtext-Ausstattung gehört und buchweit für alle Ausgabewege
   *  gilt. */
  async saveXrefSettings(bookId = this._formBookId) {
    if (!bookId || !this.bookCitationLoaded) return false;
    this.xrefSaving = true;
    this.xrefSaved = false;
    this.xrefError = '';
    const sent = this._snapKey('xref');
    try {
      const r = await fetch(`/booksettings/${bookId}/xrefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._xrefSnapshot()),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d));
      }
      const data = await r.json();
      if (this._isFormBook(bookId)) this._settleSave('xref', sent, () => { this.bookXref = _xrefFrom(data); });
      this.xrefSaved = true;
      this._flash('xrefSaved');
      window.__app?.invalidateBookSettingsCache?.();
      // Der Ziel-Picker im Editor cacht Abbildungen und Tabellen samt
      // Vorschau-Nummer; ohne Nummerierung zeigt er den Beschriftungstext. Cache verwerfen.
      window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED, { detail: { bookId } }));
      return true;
    } catch (e) {
      this.xrefError = e.message;
      return false;
    } finally {
      this.xrefSaving = false;
    }
  },

  async saveCitationSettings(bookId = this._formBookId) {
    // Nicht speichern, bevor der Stand geladen ist: ein ungeladener Default
    // würde den DB-Stand überschreiben.
    if (!bookId || !this.bookCitationLoaded) return false;
    this.citationSaving = true;
    this.citationSaved = false;
    this.citationError = '';
    const sent = this._snapKey('citation');
    try {
      const r = await fetch(`/booksettings/${bookId}/citation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._citationSnapshot()),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d));
      }
      const data = await r.json();
      if (this._isFormBook(bookId)) this._settleSave('citation', sent, () => { this.bookCitation = _citationFrom(data); });
      window.__app?.invalidateBookSettingsCache?.();
      this.citationSaved = true;
      this._flash('citationSaved');
      // Der Kurzbeleg-Chip im Editor formatiert nach `citationStyleForCurrentBook`
      // (Root-State, gesetzt beim Buchwechsel). Nach einem Stilwechsel sofort
      // spiegeln, sonst schreibt der nächste eingefügte Chip noch im alten Stil.
      if (this._isSelectedBook(bookId)) window.__app.citationStyleForCurrentBook = data.citation_style || DEFAULT_STYLE;
      // Der Beleg-Picker cacht die Quellenliste je Buch; sein Label hängt am
      // Stil. Cache verwerfen, damit die Trefferliste neu formatiert.
      window.dispatchEvent(new CustomEvent(EVT.SOURCES_CHANGED, { detail: { bookId } }));
      return true;
    } catch (e) {
      this.citationError = e.message;
      return false;
    } finally {
      this.citationSaving = false;
    }
  },

  citationStyleOptions() {
    const app = window.__app;
    return CITATION_STYLES.map(s => ({ value: s, label: app.t(`sources.style.${s}`) }));
  },

  citationNotesOptions() {
    const app = window.__app;
    return CITATION_NOTES.map(v => ({ value: v, label: app.t(`book.settings.cite.notes.${v}`) }));
  },

  citationScopeOptions() {
    const app = window.__app;
    return [
      { value: 'cited', label: app.t('book.settings.cite.scope.cited') },
      { value: 'all',   label: app.t('book.settings.cite.scope.all') },
    ];
  },

  /** Live-Vorschau eines Verzeichniseintrags im gewaehlten Stil, in der Sprache
   *  des BUCHS (nicht der UI-Locale) — genau so landet er spaeter im Export. */
  citationPreview() {
    return formatFull(PREVIEW_SOURCE, {
      style: this.bookCitation?.citation_style || DEFAULT_STYLE,
      lang: this.bookSettingsLanguage || 'de',
    });
  },

  /** Sprung in die Quellen-Karte („Quellen verwalten"). Die Karten sind
   *  exklusiv — der Toggle schliesst die Bucheinstellungen. */
  openSourcesCard() {
    window.__app.toggleSourcesCard();
  },
};

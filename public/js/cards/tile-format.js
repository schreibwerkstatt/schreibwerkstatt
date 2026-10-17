// Geteilte Formatierer der Tile-Raster (`.overview-grid`/`.overview-tile`).
//
// Zwei Karten rendern dieselben Kacheln mit denselben Zahlen: die
// Buch-Uebersicht (`bookOverviewCard`) und das Kapitel-Dashboard der
// Kapitel-Bewertung (`kapitelReviewCard`). Die Formatierung gehoert damit
// nicht mehr in `book-overview/` — CLAUDE.md, „Besitzer-Regel": was mehrere
// Karten benutzen, lebt in der geteilten Datei, nicht in der, die es zuerst
// brauchte.
//
// Alle Locale-abhaengigen Ausgaben laufen ueber die gecachten Intl-Fabriken
// aus `utils` statt ueber `toLocaleString`: ein Tile formatiert pro Render
// dreistellig viele Werte, und `Number#toLocaleString` baut den Formatter bei
// jedem Aufruf neu.
import { charsToNormseiten, numberFormat, dateTimeFormat, formatIsoDay } from '../utils.js';

export const tileFormatMethods = {
  // Aktuelle UI-Sprache ('de' | 'en'). Eine Stelle, damit die
  // Store-Zugriffs-Kette nicht durch alle Tile-Module wandert.
  _uiLocale() {
    return Alpine.store('shell').uiLocale;
  },

  // Gecachter Zahlen-Formatter fuer die aktuelle UI-Sprache.
  _numFmt(opts) {
    return numberFormat(this._uiLocale(), opts);
  },

  // Gecachter Datums-Formatter fuer die aktuelle UI-Sprache (timeZone via tzOpts).
  _dateFmt(opts) {
    return dateTimeFormat(this._uiLocale(), opts);
  },

  // Label eines ISO-Kalendertags (utils/date.js#formatIsoDay: UTC-Mittag +
  // timeZone UTC — kein Kippen auf den Nachbartag bei TZ-Differenz).
  _isoDayLabel(iso, opts) {
    return formatIsoDay(iso, this._uiLocale(), opts);
  },

  _fmtNum(n) {
    return this._numFmt().format(Number(n) || 0);
  },

  // Zeichen -> lokalisierte Normseiten-Zahl (1 Dezimale). Kapselt die
  // CHARS_PER_NORMSEITE-Umrechnung, damit die Formel nicht in jedem Tile
  // inline dupliziert wird.
  _fmtNormseiten(chars) {
    return this._numFmt({ minimumFractionDigits: 1, maximumFractionDigits: 1 })
      .format(charsToNormseiten(chars));
  },

  // Fehler-Typ-Label: i18n-Key versuchen; Fallback humanisiert.
  tileFehlerLabel(typ) {
    const key = 'fehlerHeatmap.typ.' + typ;
    const app = window.__app;
    const translated = app?.t ? app.t(key) : null;
    if (translated && translated !== key) return translated;
    const s = String(typ || '').replace(/_/g, ' ').replace(/\bvs\b/, 'vs.');
    return s.charAt(0).toUpperCase() + s.slice(1);
  },

  // Initialen fuer Avatar-Chip: erste Buchstaben aus Vor-/Nachname.
  tileInitials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },
};

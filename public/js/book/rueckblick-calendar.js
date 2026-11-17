// Tagebuch-Rückblick: Kalender der Leiste (Jahr×Monat + Jahres-Spalte aus der
// Coverage, book/ymheatmap.js) und Zustand des Hauptbereichs. Ein Klick in
// Kalender oder Liste wählt immer nur den Zeitraum; was der Hauptbereich zeigt,
// sagt rbPeriodState(). Gespreadet in tagebuchRueckblickCard neben
// tagebuch-rueckblick.js (Zeitraum, Aktualität, History, Facetten).

import { localeTag, tzOpts } from '../utils.js';
import { buildYmHeatRows, ymHeatCellClass } from './ymheatmap.js';
import { scrollToWhenReady } from '../utils/scroll-when-ready.js';

export const rueckblickCalendarMethods = {
  // ── Zustand des Hauptbereichs ──────────────────────────────────────────────
  // Was der gewählte Zeitraum zeigt — ein Klick in Kalender oder Liste wählt
  // nur den Zeitraum, der Hauptbereich folgt diesem Zustand:
  //  'result'  Rückblick offen          'create'  Einträge, noch kein Rückblick
  //  'hidden'  Rückblick da, geschlossen 'empty'   keine Einträge im Zeitraum
  //  'noDated' Buch ohne datierte Einträge
  //  ''        nichts anzeigen (Lauf aktiv, Daten laden, Rückblick lädt)
  rbPeriodState() {
    if (this.rueckblickLoading) return '';
    if (this.hasRueckblickResult()) return 'result';
    if (!this.rbHistoryLoaded) return '';
    if (this.rbCoverage && this.rbCoverage.minYear == null) return 'noDated';
    if (!this.rueckblickZeitraum) return '';
    if (this.rueckblickEmpty) return 'empty';
    const latest = this.rbLatestEntry();
    if (latest) return this.selectedRueckblickId != null ? '' : 'hidden';
    // Ohne Coverage (Ladefehler) nicht blockieren — der Job meldet Leere selbst.
    if (!this.rbCoverage || this.rbEntryCount() > 0) return 'create';
    return 'empty';
  },

  // Leiste steht, sobald das Buch datierte Einträge hat.
  rbHasCalendar() {
    return this.rueckblickCalendar().years.length > 0;
  },

  // Schmal steht die Leiste über dem Hauptbereich: nach einer Wahl dorthin
  // springen, sonst bliebe der Klick ohne sichtbare Folge.
  _revealRueckblickMain() {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia('(min-width: 1280px)').matches) return;
    scrollToWhenReady('#tagebuch-rueckblick-card', { block: 'start' });
  },

  // Zeile der Liste anklicken: Rückblick öffnen und schmal zum Hauptbereich.
  pickRueckblickEntry(entry) {
    if (this.rueckblickLoading) return;
    this.openRueckblickHistory(entry);
    this._revealRueckblickMain();
  },

  // ── Kalender (Jahr×Monat aus der Coverage) ─────────────────────────────────
  rueckblickCalendar() {
    return this._memo('rbCal', [this.rbCoverage], () => buildYmHeatRows(this.rbCoverage));
  },

  rbMonthLabels() {
    const locale = localeTag(Alpine.store('shell').uiLocale);
    return this._memo('rbMonthLabels', [locale], () => {
      const fmt = new Intl.DateTimeFormat(locale, tzOpts({ month: 'short', timeZone: 'UTC' }));
      const out = [];
      for (let m = 0; m < 12; m++) out.push(fmt.format(new Date(Date.UTC(2024, m, 15, 12))));
      return out;
    });
  },

  // «18 von 203 Monaten mit Rückblick»
  rbCalSummary() {
    const cal = this.rueckblickCalendar();
    return window.__app.t('rueckblick.cal.summary', { done: cal.monthsWithRueckblick, total: cal.monthsWithEntries });
  },

  rbCalCellClass(cell) {
    return ymHeatCellClass(cell, this.rueckblickZeitraum);
  },

  // Zelle (Monat oder Jahres-Spalte) anklicken: Zeitraum wählen — ein
  // vorhandener Rückblick öffnet sich (_applyRueckblickZeitraum), sonst zeigt
  // der Hauptbereich den Erstellen-Aufruf. Während eines Laufs gesperrt — das
  // Ergebnis gehört dem Zeitraum des Laufs.
  openCalendarCell(cell) {
    if (this.rueckblickLoading) return;
    if (!cell || !(cell.hasRueckblick || cell.hasEntries)) return;
    this._applyRueckblickZeitraum(cell.key);
    this._revealRueckblickMain();
  },

  rbCalCellTip(cell) {
    const app = window.__app;
    const period = cell.isYear
      ? `${app.t('rueckblick.grain.year')} ${cell.key}`
      : `${this.rbMonthLabels()[cell.monthIdx - 1]} ${cell.key.slice(0, 4)}`;
    const count = cell.entries ? ` · ${this.rbCountLabel(cell.entries)}` : '';
    if (cell.hasRueckblick) {
      const tip = `${period}${count}: ${app.t('rueckblick.cal.tipHas', { date: this.rueckblickEntryDate(cell.createdAt) })}`;
      return cell.stale ? `${tip} · ${app.t('rueckblick.cal.legendStale')}` : tip;
    }
    if (cell.hasEntries) return `${period}${count}: ${app.t('rueckblick.cal.tipGenerate')}`;
    return `${period}: ${app.t('rueckblick.cal.tipEmpty')}`;
  },
};

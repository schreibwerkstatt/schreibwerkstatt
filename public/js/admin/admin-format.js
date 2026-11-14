// Anzeige-Formate aller Admin-Karten an einer Stelle: Bytes und Zeitpunkte in
// der UI-Sprache. Zeitpunkte laufen über fmtDateTime (utils/date.js: tzOpts +
// robustes Parsen von ISO mit/ohne Zone und SQLite-UTC-Strings) — kein
// handgebautes toLocaleString mit eigener Locale-Zuordnung im Template.

import { fmtBytes, fmtDateTime } from '../utils.js';

const _locale = () => window.Alpine?.store('shell')?.uiLocale;

/** Datum + Uhrzeit (Minuten); `—` ohne Wert. Auch ausserhalb von Alpine nutzbar. */
export function adminFmtDateTime(value, opts) {
  if (value == null || value === '') return '—';
  return fmtDateTime(value, _locale(), opts);
}

// Gespreadet in die Admin-Karten; das Lesen der Locale hält die Anzeige beim
// Sprachwechsel reaktiv.
export const adminFormatMethods = {
  adminFmtBytes(n) {
    return fmtBytes(Number(n) || 0, _locale());
  },
  adminFmtDateTime(value) {
    return adminFmtDateTime(value);
  },
  /** Datum + Uhrzeit mit Sekunden (Fehler-Protokolle). */
  adminFmtDateTimeSec(value) {
    return adminFmtDateTime(value, { dateStyle: 'medium', timeStyle: 'medium' });
  },
  /** Nur das Datum (Ablauf, Anlage). */
  adminFmtDay(value) {
    return adminFmtDateTime(value, { dateStyle: 'medium' });
  },
};

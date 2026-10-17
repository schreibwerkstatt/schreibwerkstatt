// Kalendertag-Arithmetik auf ISO-Strings (YYYY-MM-DD) — SSoT fuer das ganze
// Frontend (Buch-Uebersicht, Kapitel-Wachstum, Meine Statistik, Streak-Grid).
//
// Der Anker ist immer `localIsoDate()` (appTimezone), die Rechnung danach reine
// Kalenderarithmetik ueber einen UTC-Mittag — unabhaengig von der Zeitzone des
// Browsers und DST-sicher. Ein `new Date()` + `setHours(12)` + `setDate(-n)`
// rechnet dagegen im Kalender des BROWSERS: steht der in einer anderen Zone als
// die App, landet „heute" auf dem Vor- oder Folgetag der Server-Buckets.
//
// Pure Funktionen (Alpine-/DOM-frei, keine Imports) → unit-testbar, siehe
// tests/unit/book-overview-iso-day.test.mjs.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** ISO-Tag → Date am UTC-Mittag dieses Kalendertags (null bei ungültigem Input). */
export function isoNoonUtc(iso) {
  const m = ISO_RE.exec(String(iso || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/** Kalendertag `n` Tage nach `iso` (negativ = davor). */
export function isoAddDays(iso, n) {
  const d = isoNoonUtc(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Ganztage-Differenz b − a (positiv = b liegt nach a). */
export function isoDaysBetween(aIso, bIso) {
  const a = isoNoonUtc(aIso);
  const b = isoNoonUtc(bIso);
  if (!a || !b) return NaN;
  return Math.round((b - a) / 86400000);
}

/** Wochentag eines ISO-Tags (0 = Sonntag … 6 = Samstag), zeitzonenfrei. */
export function isoWeekday(iso) {
  const d = isoNoonUtc(iso);
  return d ? d.getUTCDay() : NaN;
}

/** Wochentag eines ISO-Tags, Montag-basiert (0 = Montag … 6 = Sonntag). */
export function isoWeekdayMon(iso) {
  const wd = isoWeekday(iso);
  return Number.isNaN(wd) ? NaN : (wd + 6) % 7;
}

/** Die letzten `days` Kalendertage bis einschliesslich `todayIso`, ältester zuerst. */
export function isoLastDays(todayIso, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(isoAddDays(todayIso, -i));
  return out;
}

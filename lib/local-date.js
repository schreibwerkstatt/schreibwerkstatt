'use strict';
// Server-Helper für lokale Datums-Strings (YYYY-MM-DD).
// `new Date().toISOString().slice(0,10)` ist UTC und kann in CEST/CET um 1
// Tag verschoben sein (lokal Mitternacht = UTC vor-22:00). Bug-Symptom:
// heutige Schreibzeichen landen im Streak-Grid auf dem Vortag, weil Server
// und Frontend auf unterschiedliche Datums-Strings mappen.
//
// TZ kommt aus app_settings (`app.timezone`). Single Source of Truth — derselbe
// Wert treibt node-cron in server.js und Frontend-Display-Formatter.
// Lazy require fuer den Settings-Lookup vermeidet Boot-Reihenfolge-Bruch
// (lib/local-date.js wird sehr frueh geladen).

const FALLBACK_TZ = 'Europe/Zurich';

function currentTz() {
  try {
    const appSettings = require('./app-settings');
    return appSettings.get('app.timezone') || FALLBACK_TZ;
  } catch (_) {
    return FALLBACK_TZ;
  }
}

/**
 * Lokales ISO-Datum (YYYY-MM-DD). 'en-CA'-Locale liefert das ISO-Format
 * unabhängig von der System-Locale. timeZone respektiert app.timezone.
 */
function localIsoDate(d = new Date(), tz = currentTz()) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Lokales ISO-Datum n Tage in der Vergangenheit. Mittag-Anker statt Mitternacht
 * macht ±n*86_400_000 DST-Drift-sicher (an Umstellungs-Tagen kann ein 24-h-Step
 * sonst dieselbe Datums-Seite zweimal treffen).
 */
function localIsoDaysAgo(n, base = new Date(), tz = currentTz()) {
  const noon = new Date(base);
  noon.setHours(12, 0, 0, 0);
  noon.setDate(noon.getDate() - n);
  return localIsoDate(noon, tz);
}

/**
 * Lokale Stunde (0-23) in tz. Treibt das Tageszeit-Histogramm der Schreibzeit
 * (writing_hour): der Heartbeat-Delta wird der aktuellen lokalen Stunde
 * zugeschlagen. Stundengrenzen werden naeherungsweise behandelt (ein 15-s-Ping
 * landet ganz in der Stunde seines Empfangs) — analog zur Tages-Mitternacht in
 * localIsoDate.
 */
function localHour(d = new Date(), tz = currentTz()) {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(d);
  const n = parseInt(h, 10);
  return Number.isFinite(n) ? (n === 24 ? 0 : n) : 0;
}

// Offset (ms) zwischen UTC und tz für gegebenen Instant. Positiv: tz vor UTC.
function _tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                         hour, Number(p.minute), Number(p.second));
  return asUtc - date.getTime();
}

/**
 * UTC-ISO-Instant des Monatsersten 00:00 in tz. Treibt Monats-Buckets
 * (Cost-Aggregation, Budget-Period) so, dass sie mit der App-Anzeige matchen
 * statt UTC-Mitternacht zu folgen.
 */
function localMonthStartIso(d = new Date(), tz = currentTz()) {
  const ym = localIsoDate(d, tz).slice(0, 7);
  const naive = new Date(`${ym}-01T00:00:00Z`);
  // Zwei Iterationen: behandeln DST-Edge, falls Naive-Offset über Boundary kippt.
  let instant = new Date(naive.getTime() - _tzOffsetMs(naive, tz));
  instant = new Date(naive.getTime() - _tzOffsetMs(instant, tz));
  return instant.toISOString();
}

/** UTC-ISO-Instant des heutigen 00:00 in tz — Untergrenze für „heute"-Summen
 *  über ISO-Timestamps (z.B. `ai_cost_ledger.ts`). */
function localDayStartIso(d = new Date(), tz = currentTz()) {
  const naive = new Date(`${localIsoDate(d, tz)}T00:00:00Z`);
  let instant = new Date(naive.getTime() - _tzOffsetMs(naive, tz));
  instant = new Date(naive.getTime() - _tzOffsetMs(instant, tz));
  return instant.toISOString();
}

/** Aktuelle Monatsperiode (YYYY-MM) in tz. */
function localMonthPeriod(d = new Date(), tz = currentTz()) {
  return localIsoDate(d, tz).slice(0, 7);
}

module.exports = { localIsoDate, localIsoDaysAgo, localHour, localDayStartIso, localMonthStartIso, localMonthPeriod, currentTz };

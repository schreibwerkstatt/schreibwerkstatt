// Zeitzone (app-weite SSoT) + ISO-Datums-Helper + relative Zeit-Formatter.
// Alle Date-Display-Pfade hängen an `appTimezone`, damit GUI-Zeit zur
// Server-Zeit passt.
import { localeTag } from './format.js';

// App-weite Zeitzone (Single Source of Truth, kommt vom Server via /config
// → app_settings.app.timezone). Treibt localIsoDate, Date-Display-Formatter
// (toLocaleString, Intl.DateTimeFormat) und Streak-Buckets. Browser-TZ wird
// damit ueberschrieben, damit GUI-Zeit zur Server-Zeit passt — z.B. ein in
// Zurich gehosteter Server zeigt fuer einen User, der gerade in NY ist,
// trotzdem Zurich-Zeit.
export let appTimezone = 'Europe/Zurich';

export function configureAppTimezone(tz) {
  if (typeof tz === 'string' && tz.length > 0) appTimezone = tz;
}

// Helper fuer Intl-Options-Bag: mergt `timeZone: appTimezone` in einen
// Options-Object, ohne ein explizites timeZone zu ueberschreiben.
export function tzOpts(opts = {}) {
  return opts.timeZone ? opts : { ...opts, timeZone: appTimezone };
}

// Pro (Locale, Options) gecachter Intl.DateTimeFormat, `timeZone` immer via
// tzOpts gemergt (harte Regel „Frontend-Datums-Display nur via tzOpts"). Spart
// die Formatter-Konstruktion in Schleifen (Wochentags-Labels, Sparkline-Punkte,
// Heatmap-Zellen) und macht das tzOpts-Wrapping unvergesslich.
const _DTF_CACHE = new Map();
export function dateTimeFormat(uiLocale, opts = {}) {
  const tag = localeTag(uiLocale);
  const merged = tzOpts(opts);
  const key = tag + '|' + JSON.stringify(merged);
  let dtf = _DTF_CACHE.get(key);
  if (!dtf) { dtf = new Intl.DateTimeFormat(tag, tzOpts(merged)); _DTF_CACHE.set(key, dtf); }
  return dtf;
}

// Pro Locale gecacht — Intl.RelativeTimeFormat-Konstruktion ist nicht gratis,
// und _fmtRelativeLine wird pro Sidebar-Render mehrfach aufgerufen.
const _RTF_CACHE = new Map();
export function relativeDay(diffDays, uiLocale) {
  const tag = localeTag(uiLocale);
  let rtf = _RTF_CACHE.get(tag);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
    _RTF_CACHE.set(tag, rtf);
  }
  return rtf.format(-diffDays, 'day');
}

// Relative Last-Run-Anzeige aus ISO-Timestamp. Server liefert nur den ISO-
// String; Lokalisierung passiert hier (i18n-Hard-Rule). `t` ist die i18n-Funktion,
// `uiLocale` der Sprachcode aus der App ('de' oder 'en'). Intl.RelativeTimeFormat
// liefert „heute"/„gestern"/„vor 3 Tagen" lokalisiert; Template setzt Time daneben.
export function formatLastRun(isoStr, t, uiLocale) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const tag = localeTag(uiLocale);
  const time = d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  const diffDays = localDayDiff(d);
  if (diffDays < 7) return t('job.lastRun.rel', { rel: relativeDay(diffDays, uiLocale), time });
  const date = d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit' }));
  return t('job.lastRun.dateAt', { date, time });
}

// Kurz-relative Zeit aus ISO-Timestamp („vor 3 Minuten"/„vor 2 Stunden"/
// „vor 1 Tag"), lokalisiert via Intl.RelativeTimeFormat. Anders als
// formatLastRun (Tag-Bucket + Uhrzeit) feiner gestaffelt — passend für
// push-getriebene „Zuletzt bearbeitet"-Hints. Unter 1 Minute auf 1 geklemmt,
// damit nie „in 0 Minuten" erscheint.
export function formatRelativeShort(isoStr, uiLocale) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const tag = localeTag(uiLocale);
  let rtf = _RTF_CACHE.get(tag);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
    _RTF_CACHE.set(tag, rtf);
  }
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 60) return rtf.format(-Math.max(diffMin, 1), 'minute');
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return rtf.format(-diffH, 'hour');
  return rtf.format(-Math.round(diffH / 24), 'day');
}

// Lokales ISO-Datum (YYYY-MM-DD) — kein UTC. `new Date().toISOString().slice(0,10)`
// liefert UTC-Datum, das in CET um 1 Tag verschoben sein kann (lokal Mitternacht
// = UTC vor-22:00 Tag). Bug-Symptom: heutige Zeichen landen im Streak-Grid auf
// dem Vortag, weil Frontend-Iteration und Server-Snapshots auf unterschiedliche
// Datums-Strings mappen. Beide Seiten müssen lokal-konsistent sein.
//
// 'en-CA' liefert Format YYYY-MM-DD, ist sortier-tauglich, immutable per ECMA-402.
// timeZone ist die app-weite appTimezone (matcht Server-Datums-Buckets).
export function localIsoDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: appTimezone });
}

// Kalendertage zwischen `then` und `now` in appTimezone (nicht Browser-TZ):
// 0 = heute, 1 = gestern. Konsistent mit den Server-Buckets (lib/local-date.js),
// auch wenn der Browser des Users in einer anderen TZ steht. UTC-Mittag-Anker
// macht die Differenz DST-sicher. Ungültiges `then` → NaN.
export function localDayDiff(then, now = new Date()) {
  const a = then instanceof Date ? then : new Date(then);
  if (isNaN(a.getTime())) return NaN;
  const dThen = Date.parse(localIsoDate(a) + 'T12:00:00Z');
  const dNow = Date.parse(localIsoDate(now) + 'T12:00:00Z');
  return Math.round((dNow - dThen) / 86400000);
}

// Reine Tages-Arithmetik auf ISO-Datumsstrings (YYYY-MM-DD), TZ-frei via UTC:
// UTC kennt keine DST, Tagesschritte sind exakt. `iso` + n Kalendertage.
export function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Lokales ISO-Datum n App-Tage vor `base`: erst das App-TZ-Datum von `base`
// bestimmen (localIsoDate), dann reine ISO-Tagesarithmetik. Kein Rechnen auf
// Uhrzeiten der Browser-TZ — steht der Browser in einer anderen Zone als
// `appTimezone`, verschob ein Browser-Mittag-Anker das Datum um einen Tag.
export function localIsoDaysAgo(n, base = new Date()) {
  return isoAddDays(localIsoDate(base), -n);
}

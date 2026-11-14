// Zeitzone (app-weite SSoT) + ISO-Datums-Helper + relative Zeit-Formatter.
// Alle Date-Display-Pfade hängen an `appTimezone`, damit GUI-Zeit zur
// Server-Zeit passt.
import { localeTag } from './format.js';
import { isoAddDays, isoNoonUtc } from './iso-day.js';

// Direkt-Importeure von utils/date.js (native Editor-Hosts im OTA-Bundle) behalten isoAddDays.
export { isoAddDays };

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

// DB-Zeitstempel → Date. Neue Zeilen tragen ISO mit Z (NOW_ISO_SQL); ältere
// das SQLite-Format ohne Zone ("YYYY-MM-DD HH:MM:SS", UTC) — ohne
// Normalisierung läse der Browser es als Lokalzeit. Date/ms gehen unverändert
// durch. Kein Anhängen von 'Z' an fremde Strings: ein ISO-Wert mit Zone würde
// dadurch zu „Invalid Date".
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
export function parseServerTs(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const s = String(value ?? '').trim();
  if (SQLITE_TS_RE.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}

// Zeitstempel (ISO-String, SQLite-UTC-String, Date oder ms) als Datum + Uhrzeit
// in UI-Sprache und App-Zeitzone. Leer → ''; unparsebar → Eingabe unverändert
// (statt „Invalid Date"). Default `medium`/`short`; eigene Stile per `opts`.
export function fmtDateTime(value, uiLocale, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (value == null || value === '') return '';
  const d = parseServerTs(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return dateTimeFormat(uiLocale, opts).format(d);
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

// Lokales ISO-Datum n App-Tage vor `base`: erst das App-TZ-Datum von `base`
// bestimmen (localIsoDate), dann reine ISO-Tagesarithmetik (utils/iso-day.js). Kein Rechnen auf
// Uhrzeiten der Browser-TZ — steht der Browser in einer anderen Zone als
// `appTimezone`, verschob ein Browser-Mittag-Anker das Datum um einen Tag.
export function localIsoDaysAgo(n, base = new Date()) {
  return isoAddDays(localIsoDate(base), -n);
}

// Label eines ISO-Kalendertags (YYYY-MM-DD, auch Prefix eines Zeitstempels):
// UTC-Mittag + `timeZone: 'UTC'` zeigt genau den Kalendertag des Strings —
// egal in welcher Zone Browser und App stehen. Ein Browser-Mittag
// (`iso + 'T12:00:00'`) oder ein UTC-Mittag in appTimezone formatiert kippt
// dagegen auf den Nachbartag, sobald eine der Zonen >12 h von UTC bzw. von der
// anderen entfernt ist. Ein Tag ist eine Kalenderangabe, keine Uhrzeit — die
// appTimezone-Regel (tzOpts) gilt fuer Zeitpunkte. '' bei ungueltigem Input.
export function formatIsoDay(iso, uiLocale, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = isoNoonUtc(iso);
  return d ? dateTimeFormat(uiLocale, { ...opts, timeZone: 'UTC' }).format(d) : '';
}

// Offset der Zone `tz` zum Zeitpunkt `ms` in Minuten (Wanduhr − UTC).
function _tzOffsetMin(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

// Wanduhrzeit der App-Zeitzone (`YYYY-MM-DDTHH:mm` aus `<input type=
// datetime-local>`) → UTC-ISO-String. Das Eingabefeld kennt keine Zone; ohne
// Umrechnung planten Browser in einer anderen Zone als `appTimezone` den
// Blog-Beitrag zur falschen Stunde. Zwei Durchgaenge fangen den DST-Wechsel
// zwischen Schaetzung und Ergebnis. Ungueltige Eingabe → ''.
export function zonedWallToIso(value, tz = appTimezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!m) return '';
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let ms = wall - _tzOffsetMin(wall, tz) * 60000;
  ms = wall - _tzOffsetMin(ms, tz) * 60000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// Kapitel-Entstehung — reiner Rechenkern der „Entwicklung"-Kachel im
// Kapitel-Dashboard. Ohne `this`, ohne Alpine, ohne i18n: die Methoden in
// cards/kapitel-dashboard.js sind nur memoisierte Huellen darum, die Beschriftung
// baut das Template.
//
// Eingabe ist die Antwort von `GET /history/chapter-growth/:book_id`: je Kapitel
// eine Zeitreihe seiner ABSOLUTEN Groesse, und zwar nur an Tagen mit Aenderung
// (Vertrag + Grenzen der Quelle: lib/chapter-growth.js).
//
// Drei Regeln, die diese Datei gegen die Nachbarkachel „Umfang" wahren muss:
//
//   * **Seiten ohne Fassung sind nicht leer, sondern unveraendert.** Eine Seite,
//     die seit dem ersten festgehaltenen Stand nie gespeichert wurde (Import,
//     Anlage vor der Fassungs-Historie), taucht in keiner Reihe auf. Sie zaehlt
//     als KONSTANTER Sockel ueber den ganzen Zeitraum — sie war da und hat sich
//     nicht bewegt. Ohne den Sockel saehe das Kapitel kleiner aus, als es ist.
//   * **Der rechte Rand ist der Live-Stand**, nicht die letzte Fassung. Die
//     Kachel steht neben „Umfang"; zwei verschiedene Zahlen fuer „jetzt" waeren
//     der erste Fehler, den man sieht.
//   * **Der linke Rand ist der erste festgehaltene Stand, kein Nullpunkt.** Ein
//     vor der Fassungs-Historie importiertes Kapitel beginnt darum nicht bei
//     null, und der ausgewiesene Zuwachs gilt AB diesem Datum — die Kachel sagt
//     das Datum darum immer dazu.
import { localIsoDate } from '../utils.js';
import { isoAddDays, isoDaysBetween as isoDiffDays } from '../utils/iso-day.js';

// Obergrenze der Kurvenpunkte. Die Achse wird in gleich breite Zeitscheiben
// geteilt: gleich weite Punkte UND zeitproportionale Lage zugleich. Bei kurzen
// Zeitraeumen bleibt es bei Tagesscheiben.
export const MAX_POINTS = 48;

/** Tage zwischen zwei ISO-Datums-Strings (b − a) und ISO-Datum + n Tage:
 *  reine Kalenderarithmetik ueber den UTC-Mittag (SSoT utils/iso-day.js).
 *  Kein Browser-Mittag: liegen Browser-TZ und appTimezone mehr als 12 h
 *  auseinander, landete localIsoDate() eines Browser-Mittags auf dem Nachbartag. */
export { isoDiffDays, isoAddDays };

/**
 * Reihen mehrerer Kapitel zu EINER Reihe des Scopes verschmelzen.
 * Erlaubt ist das nur, weil die Punkte absolute Staende sind: die Summe
 * fortgeschriebener Reihen ist die Fortschreibung der Summe.
 */
export function mergeScopeSeries(chapters, ids) {
  const series = [];
  const tracked = new Set();
  for (const id of ids || []) {
    const entry = (chapters || {})[String(id)];
    if (!entry || !entry.points?.length) continue;
    series.push(entry.points);
    for (const pid of entry.pages || []) tracked.add(Number(pid));
  }
  if (!series.length) return { points: [], tracked };

  // Union der Tage, je Kapitel der letzte bis dahin bekannte Wert.
  const days = [...new Set(series.flatMap(p => p.map(x => x.d)))].sort();
  const cursor = series.map(() => -1);
  const lastVal = series.map(() => ({ c: 0, w: 0 }));
  const points = [];
  for (const d of days) {
    for (let i = 0; i < series.length; i++) {
      const pts = series[i];
      while (cursor[i] + 1 < pts.length && pts[cursor[i] + 1].d <= d) {
        cursor[i]++;
        lastVal[i] = { c: pts[cursor[i]].c, w: pts[cursor[i]].w };
      }
    }
    let c = 0, w = 0;
    for (const v of lastVal) { c += v.c; w += v.w; }
    points.push({ iso: d, chars: c, words: w });
  }
  return { points, tracked };
}

/** Zeitproportionale Verdichtung auf hoechstens `maxPoints` Scheiben zwischen
 *  erstem Punkt und heute. Jede Scheibe traegt den letzten bis zu ihrem Ende
 *  bekannten Stand (die Kurve ist eine Treppe, kein Messpunkt-Zug). */
export function bucketSeries(points, todayIso, maxPoints = MAX_POINTS) {
  if (!points.length) return [];
  const firstIso = points[0].iso;
  const span = Math.max(0, isoDiffDays(firstIso, todayIso)) + 1;
  const n = Math.max(1, Math.min(maxPoints, span));
  const out = [];
  let cursor = 0;
  let last = points[0];
  for (let i = 0; i < n; i++) {
    const endIso = isoAddDays(firstIso, Math.ceil(((i + 1) * span) / n) - 1);
    while (cursor + 1 < points.length && points[cursor + 1].iso <= endIso) {
      cursor++;
      last = points[cursor];
    }
    out.push({ iso: endIso, chars: last.chars, words: last.words });
  }
  return out;
}

/** SVG-Geometrie der Kurve (Pfad, Flaeche, Endpunkt) im gegebenen Viewbox. */
export function growthGeometry(buckets, { w = 480, h = 96, pad = 4 } = {}) {
  const data = buckets.map(b => b.chars);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(1, max - min);
  const stepX = data.length > 1 ? (w - 2 * pad) / (data.length - 1) : 0;
  const pts = data.map((v, i) => [
    pad + i * stepX,
    h - pad - ((v - min) / span) * (h - 2 * pad),
  ]);
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = `${d} L ${pts[pts.length - 1][0].toFixed(1)},${(h - pad).toFixed(1)}`
             + ` L ${pts[0][0].toFixed(1)},${(h - pad).toFixed(1)} Z`;
  return { d, area, endX: pts[pts.length - 1][0], endY: pts[pts.length - 1][1], w, h };
}

/**
 * Vollstaendiges Modell der Kachel.
 *
 * @param {object} chapters   `chapters` der /history/chapter-growth-Antwort
 * @param {Set<string>} ids   Kapitel im Scope
 * @param {Array} scopePages  Seiten im Scope (Baum-Reihenfolge)
 * @param {object} tokEsts    Live-Stand je Seite
 * @param {{todayIso?:string, maxPoints?:number}} opts
 * @returns {null|object}     `null`, solange die Quelle nichts hergibt — die
 *                            Kachel faellt dann weg, statt eine Null zu zeigen.
 */
export function computeGrowth(chapters, ids, scopePages, tokEsts, opts = {}) {
  const todayIso = opts.todayIso || localIsoDate();
  const { points, tracked } = mergeScopeSeries(chapters, ids);
  if (!points.length) return null;

  // Sockel + Live-Stand aus derselben Quelle wie die Umfang-Kachel.
  let baseChars = 0, baseWords = 0, liveChars = 0, liveWords = 0, untracked = 0;
  for (const p of scopePages || []) {
    const e = (tokEsts || {})[p.id] || {};
    const c = Number(e.chars) || 0;
    const wd = Number(e.words) || 0;
    liveChars += c; liveWords += wd;
    if (!tracked.has(Number(p.id))) { baseChars += c; baseWords += wd; untracked++; }
  }

  const withBase = points.map(p => ({
    iso: p.iso, chars: p.chars + baseChars, words: p.words + baseWords,
  }));
  // Heutiger Randpunkt: der Live-Stand gewinnt gegen die letzte Fassung.
  const live = { iso: todayIso, chars: liveChars, words: liveWords };
  if (withBase[withBase.length - 1].iso >= todayIso) withBase[withBase.length - 1] = live;
  else withBase.push(live);

  const firstIso = withBase[0].iso;
  const lastChangeIso = points[points.length - 1].iso;
  // Ein einziger Tag ist kein Verlauf.
  if (withBase.length < 2 || firstIso === todayIso) return null;

  const buckets = bucketSeries(withBase, todayIso, opts.maxPoints || MAX_POINTS);
  const startChars = withBase[0].chars;
  const net = liveChars - startChars;
  return {
    points: buckets,
    geometry: growthGeometry(buckets, opts.viewBox),
    firstIso,
    lastChangeIso,
    days: isoDiffDays(firstIso, todayIso) + 1,
    startChars,
    chars: liveChars,
    net,
    netPct: startChars > 0 ? Math.round((net / startChars) * 100) : null,
    trackedPages: tracked.size,
    untrackedPages: untracked,
  };
}

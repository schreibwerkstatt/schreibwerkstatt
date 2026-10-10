// Zeitreihen- und Snapshot-Helfer fuer „Meine Statistik" (Facade:
// cards/my-stats-compute.js). Pure Funktionen, Alpine-/DOM-frei.
//
// Alle Datumsrechnungen laufen auf ISO-Tagesstrings (YYYY-MM-DD) per UTC —
// nie auf Uhrzeiten der Browser-TZ, die von der App-Zeitzone abweichen kann.

import { isoAddDays } from '../../utils.js';

export { isoAddDays };

// Differenz b - a in Kalendertagen (ISO YYYY-MM-DD), TZ-frei via UTC.
export function isoDayDiff(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Wochentag eines ISO-Datums, Mo=0 … So=6 (UTC-Mittag, TZ-frei).
export function isoDowMon(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// Tages-ISO → Bucket-Schluessel je Granularitaet. Der Schluessel ist selbst ein
// sortierbares ISO-Datum (Monday-of-week bzw. Monatserster), damit X-Achse +
// Label-Formatierung dieselbe Datumslogik wie der Tagesfall nutzen koennen.
//   'day'   → das Datum selbst
//   'week'  → Montag der Kalenderwoche
//   'month' → erster Tag des Monats
export function bucketizeIso(iso, gran) {
  if (gran === 'month') return iso.slice(0, 7) + '-01';
  if (gran === 'week') return isoAddDays(iso, -isoDowMon(iso));
  return iso;
}

// Lueckenlose Bucket-Folge von `fromIso` bis `toIso` (inklusive) — die X-Achse
// einer Delta-Reihe (Schreibzeit), auf der ein Tag ohne Wert eine 0 ist und
// keine Luecke, die die Achse zusammenschiebt.
export function bucketRange(fromIso, toIso, gran) {
  if (!fromIso || !toIso || fromIso > toIso) return [];
  const out = [];
  let cur = bucketizeIso(fromIso, gran);
  const end = bucketizeIso(toIso, gran);
  while (cur <= end) {
    out.push(cur);
    if (gran === 'month') {
      const [y, m] = cur.split('-').map(Number);
      cur = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    } else {
      cur = isoAddDays(cur, gran === 'week' ? 7 : 1);
    }
  }
  return out;
}

// Zeitreihe { date, value } auf Buckets verdichten. mode='sum' summiert die
// Werte je Bucket (Tages-Deltas wie Schreibminuten), mode='last' nimmt den Wert
// des juengsten Tages je Bucket (kumulative Snapshot-Groessen wie Zeichen).
// Liefert eine nach Bucket sortierte [{ bucket, value }]-Liste.
export function aggregateByBucket(points, gran, mode) {
  if (gran === 'day') {
    return points.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map(p => ({ bucket: p.date, value: p.value }));
  }
  const buckets = new Map(); // bucket → { sum, lastDate, lastVal }
  for (const p of points) {
    const key = bucketizeIso(p.date, gran);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { sum: p.value, lastDate: p.date, lastVal: p.value });
    } else {
      cur.sum += p.value;
      if (p.date >= cur.lastDate) { cur.lastDate = p.date; cur.lastVal = p.value; }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, v]) => ({ bucket, value: mode === 'last' ? v.lastVal : v.sum }));
}

// Rows auf ein Zeitfenster [from, to] (inklusive, ISO-Strings) einschraenken.
// from/to je null = unbegrenzt. dateField ist der Feldname mit dem Tagesdatum
// (writing/lektorat: 'date', book_stats_history: 'recorded_at').
export function filterByWindow(rows, dateField, from, to) {
  return (rows || []).filter(r => {
    const d = r[dateField];
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

// Schreib-Sekunden pro Tag ueber alle Buecher summieren → Map(date → seconds).
export function secondsByDate(writingRows) {
  const m = new Map();
  for (const r of (writingRows || [])) {
    const d = r.date;
    if (!d) continue;
    m.set(d, (m.get(d) || 0) + (Number(r.seconds) || 0));
  }
  return m;
}

// ── Snapshot-Helfer (book_stats_history) ────────────────────────────────────
// Letzter Snapshot je Buch (max recorded_at).
export function latestSnapshotPerBook(historyRows) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at > prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Aeltester Snapshot je Buch (min recorded_at).
export function earliestSnapshotPerBook(historyRows) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at < prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Letzter Snapshot je Buch mit recorded_at <= cutoff (ISO YYYY-MM-DD) — der
// juengste vorhandene, nicht einer exakt am Stichtag (Wochenenden, Luecken und
// die ausgeduennte Monats-Historie aelter als ein Jahr).
export function snapshotPerBookOnOrBefore(historyRows, cutoffIso) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    if (r.recorded_at > cutoffIso) continue;
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at > prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Erster Snapshot je Buch mit recorded_at >= fromIso (und <= toIso, falls gesetzt).
export function firstSnapshotPerBookInWindow(historyRows, fromIso, toIso = null) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    if (r.recorded_at < fromIso) continue;
    if (toIso && r.recorded_at > toIso) continue;
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at < prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Aktives Zeitfenster der Karte { active, from, to } (ISO, inklusive; null =
// unbegrenzt). Freies Von/Bis hat Vorrang vor dem Tages-Preset; ein
// vertauschtes Von/Bis gilt als Bereich (kleineres Datum = Von). Preset N Tage
// = genau N Kalendertage inklusive heute (heute − (N−1) … heute).
export function resolveWindow({ rangeDays = 0, from = '', to = '', todayIso }) {
  if (from || to) {
    let f = from || null, t = to || null;
    if (f && t && f > t) [f, t] = [t, f];
    return { active: true, from: f, to: t };
  }
  if (rangeDays > 0) return { active: true, from: isoAddDays(todayIso, -(rangeDays - 1)), to: todayIso };
  return { active: false, from: null, to: null };
}

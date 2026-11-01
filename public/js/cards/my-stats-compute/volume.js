// Umfangs-Zuwachs aus der Snapshot-Historie (book_stats_history) plus dem
// Live-Stand (page_stats via books_detail). Facade: cards/my-stats-compute.js.
// Regeln + Begriffe: docs/my-stats.md „Umfang im Zeitraum".

import { localIsoDate } from '../../utils.js';
import { isoAddDays, isoDaysBetween, isoWeekdayMon, latestSnapshotPerBook, earliestSnapshotPerBook,
         snapshotPerBookOnOrBefore, firstSnapshotPerBookInWindow } from './series.js';

// Tagesgenaue Aufbewahrung der Snapshot-Historie (lib/cache-cleanup.js,
// Policy `thin-monthly`): aelter bleibt nur der Monatsend-Stand je Buch.
export const HISTORY_DAILY_DAYS = 365;
// Heuristik ohne Anlagedatum: die Historie gilt als abgeschnitten, wenn ihr
// aeltester Snapshot ueberhaupt hoechstens so viele Tage neben der
// Aufbewahrungsgrenze liegt (Daten vor Einfuehrung der Ausduennung) und das
// Buch selbst mit diesem aeltesten Stand beginnt.
const TRUNCATION_SLACK_DAYS = 7;
// Ein Rand-Snapshot (Basis bzw. Endstand) darf so viele Tage vor seinem
// Stichtag liegen, ohne dass der Wert als Naeherung gilt: ein, zwei verpasste
// Nacht-Syncs ja, die Monats-Historie aelter als ein Jahr nicht.
export const SNAPSHOT_GAP_TOLERANCE_DAYS = 3;

const num = (v) => Number(v) || 0;
// Umfang eines Snapshots ohne den kumulativen Import-Zuwachs (`imported_*`,
// lib/import-baseline.js): jede Differenz zweier solcher Werte ist geschrieben,
// nicht importiert.
export const valuesOfSnap = (s) => ({
  chars: num(s?.chars) - num(s?.imported_chars),
  words: num(s?.words) - num(s?.imported_words),
  pages: num(s?.page_count) - num(s?.imported_pages),
});
// Live-Stand ohne Import: der Zaehler steht im juengsten Snapshot des Buchs
// (ein Import synct und schreibt die heutige Zeile sofort).
const valuesOfLive = (b, latestSnap) => ({
  chars: num(b?.chars) - num(latestSnap?.imported_chars),
  words: num(b?.words) - num(latestSnap?.imported_words),
  pages: num(b?.pages) - num(latestSnap?.imported_pages),
});

/** Summe des kumulativen Import-Zuwachses ueber den juengsten Snapshot je Buch. */
export function importedTotals(historyRows) {
  const out = { chars: 0, words: 0, pages: 0 };
  for (const s of latestSnapshotPerBook(historyRows).values()) {
    out.chars += num(s.imported_chars);
    out.words += num(s.imported_words);
    out.pages += num(s.imported_pages);
  }
  return out;
}

/**
 * Im Zeitfenster [from, to] produzierter Netto-Umfang (Zeichen/Woerter/
 * Abschnitte) je Buch summiert: Endstand minus Basis.
 *
 *  - Endstand: reicht das Fenster bis heute und ist `booksDetail` (Live-Stand)
 *    gegeben, der Live-Wert — der Nacht-Snapshot von heute existiert noch
 *    nicht, ohne Live-Wert fehlte der ganze heutige Tag. Sonst der juengste
 *    Snapshot <= to.
 *  - Basis: juengster Snapshot <= from − 1. Fehlt er, ist das Buch entweder im
 *    Fenster neu (Basis 0, voller Zuwachs zaehlt) oder seine Historie reicht
 *    nicht so weit zurueck. Letzteres erkennt das Anlagedatum (`created_at` im
 *    booksDetail) bzw. ohne Anlagedatum die Heuristik „Buch beginnt mit der
 *    Historie selbst". Dann ist der erste Snapshot im Fenster die Basis und das
 *    Ergebnis traegt `approximated` (Zuwachs vor diesem Snapshot fehlt).
 *  - Liegt ein Rand-Snapshot mehr als SNAPSHOT_GAP_TOLERANCE_DAYS vor seinem
 *    Stichtag (Monats-Historie aelter als ein Jahr, ausgefallene Syncs), traegt
 *    das Ergebnis ebenfalls `approximated`.
 *  - Importe zaehlen nicht: alle Staende ohne den Import-Zaehler (valuesOfSnap).
 *
 * Netto: Loeschungen machen den Wert negativ; Importe und Beitraege von
 * Co-Autor:innen zaehlen mit (es ist die Bestandsdifferenz, keine Tipp-Messung).
 *
 * @param {Array} historyRows  book_stats_history-Rows
 * @param {string|null} fromIso
 * @param {string|null} toIso
 * @param {{ booksDetail?: Array, todayIso?: string }} [opts]
 * @returns {{ chars:number, words:number, pages:number, approximated:boolean,
 *             approxBooks:Array, usesLive:boolean }}
 */
export function computeVolumeDelta(historyRows, fromIso, toIso, opts = {}) {
  const todayIso = opts.todayIso || localIsoDate();
  const live = Array.isArray(opts.booksDetail) ? opts.booksDetail : null;
  const usesLive = !!live && (!toIso || toIso >= todayIso);

  const endSnaps = toIso ? snapshotPerBookOnOrBefore(historyRows, toIso) : latestSnapshotPerBook(historyRows);
  const latestSnaps = usesLive ? latestSnapshotPerBook(historyRows) : null;
  const liveById = new Map((live || []).map(b => [b.book_id, b]));
  const ids = new Set(endSnaps.keys());
  if (usesLive) for (const id of liveById.keys()) ids.add(id);

  const base = fromIso ? snapshotPerBookOnOrBefore(historyRows, isoAddDays(fromIso, -1)) : new Map();
  const firstInWin = fromIso ? firstSnapshotPerBookInWindow(historyRows, fromIso, toIso) : new Map();
  const earliest = fromIso ? earliestSnapshotPerBook(historyRows) : new Map();
  let globalEarliest = null;
  for (const s of earliest.values()) if (!globalEarliest || s.recorded_at < globalEarliest) globalEarliest = s.recorded_at;

  // Existierte das Buch schon vor dem Fenster, obwohl kein Snapshot davor liegt?
  const retentionEdge = isoAddDays(todayIso, -HISTORY_DAILY_DAYS);
  const existedBefore = (id) => {
    const created = liveById.get(id)?.created_at;
    if (created) return String(created).slice(0, 10) < fromIso;
    const first = earliest.get(id)?.recorded_at;
    if (!first || !globalEarliest || globalEarliest < fromIso) return false;
    if (Math.abs(isoDaysBetween(retentionEdge, globalEarliest)) > TRUNCATION_SLACK_DAYS) return false;
    return isoDaysBetween(globalEarliest, first) <= TRUNCATION_SLACK_DAYS;
  };

  const baseDay = fromIso ? isoAddDays(fromIso, -1) : null;
  const stale = (snap, dayIso) => !!snap && isoDaysBetween(snap.recorded_at, dayIso) > SNAPSHOT_GAP_TOLERANCE_DAYS;

  let chars = 0, words = 0, pages = 0;
  const approx = new Set();
  for (const id of ids) {
    const fromLive = usesLive && liveById.has(id);
    const end = fromLive ? valuesOfLive(liveById.get(id), latestSnaps.get(id)) : valuesOfSnap(endSnaps.get(id));
    if (!fromLive && toIso && stale(endSnaps.get(id), toIso)) approx.add(id);
    let b = { chars: 0, words: 0, pages: 0 };
    if (base.has(id)) {
      b = valuesOfSnap(base.get(id));
      if (stale(base.get(id), baseDay)) approx.add(id);
    } else if (fromIso && existedBefore(id)) {
      // Ohne Snapshot im Fenster (nur Live-Stand) bleibt nichts als „kein
      // messbarer Zuwachs" — besser als den ganzen Bestand als Zuwachs zu zeigen.
      b = firstInWin.has(id) ? valuesOfSnap(firstInWin.get(id)) : end;
      approx.add(id);
    }
    chars += end.chars - b.chars;
    words += end.words - b.words;
    pages += end.pages - b.pages;
  }
  const approxBooks = [...approx];
  return { chars, words, pages, approximated: approxBooks.length > 0, approxBooks, usesLive };
}

// Geschriebene Zeichen diese Woche vs. letzte Woche (Mo-Start, App-Zeitzone),
// beides ueber computeVolumeDelta — dieselbe Basis-Regel wie der Zeitraum.
// Wochengrenzen aus dem App-TZ-Datum von heute per ISO-Tagesarithmetik; mit
// `booksDetail` zaehlt der heutige Live-Stand mit.
export function computeWeeklyDelta(historyRows, todayLocal = new Date(), booksDetail = null) {
  const isoToday = localIsoDate(new Date(todayLocal));
  const monday = isoAddDays(isoToday, -isoWeekdayMon(isoToday));
  const lastMonday = isoAddDays(monday, -7);
  const lastSunday = isoAddDays(monday, -1);
  const opts = { todayIso: isoToday, booksDetail: booksDetail || undefined };
  const thisWeek = computeVolumeDelta(historyRows, monday, null, opts).chars;
  const lastWeek = computeVolumeDelta(historyRows, lastMonday, lastSunday, opts).chars;
  return { thisWeek, lastWeek };
}

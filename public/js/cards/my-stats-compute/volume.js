// Umfangs-Zuwachs aus der Snapshot-Historie (book_stats_history) plus dem
// Live-Stand (page_stats via books_detail). Facade: cards/my-stats-compute.js.
// Regeln + Begriffe: docs/my-stats.md „Umfang im Zeitraum".

import { localIsoDate } from '../../utils.js';
import { isoAddDays, isoDayDiff, isoDowMon, latestSnapshotPerBook, earliestSnapshotPerBook,
         snapshotPerBookOnOrBefore, firstSnapshotPerBookInWindow } from './series.js';

// Tagesgenaue Aufbewahrung der Snapshot-Historie (lib/cache-cleanup.js,
// Policy `thin-monthly`): aelter bleibt nur der Monatsend-Stand je Buch.
export const HISTORY_DAILY_DAYS = 365;
// Heuristik ohne Anlagedatum: die Historie gilt als abgeschnitten, wenn ihr
// aeltester Snapshot ueberhaupt hoechstens so viele Tage neben der
// Aufbewahrungsgrenze liegt (Daten vor Einfuehrung der Ausduennung) und das
// Buch selbst mit diesem aeltesten Stand beginnt.
const TRUNCATION_SLACK_DAYS = 7;

const valuesOfSnap = (s) => ({
  chars: Number(s?.chars) || 0,
  words: Number(s?.words) || 0,
  pages: Number(s?.page_count) || 0,
});
const valuesOfLive = (b) => ({
  chars: Number(b?.chars) || 0,
  words: Number(b?.words) || 0,
  pages: Number(b?.pages) || 0,
});

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
    if (Math.abs(isoDayDiff(retentionEdge, globalEarliest)) > TRUNCATION_SLACK_DAYS) return false;
    return isoDayDiff(globalEarliest, first) <= TRUNCATION_SLACK_DAYS;
  };

  let chars = 0, words = 0, pages = 0;
  const approxBooks = [];
  for (const id of ids) {
    const end = usesLive && liveById.has(id) ? valuesOfLive(liveById.get(id)) : valuesOfSnap(endSnaps.get(id));
    let b = { chars: 0, words: 0, pages: 0 };
    if (base.has(id)) {
      b = valuesOfSnap(base.get(id));
    } else if (fromIso && existedBefore(id)) {
      // Ohne Snapshot im Fenster (nur Live-Stand) bleibt nichts als „kein
      // messbarer Zuwachs" — besser als den ganzen Bestand als Zuwachs zu zeigen.
      b = firstInWin.has(id) ? valuesOfSnap(firstInWin.get(id)) : end;
      approxBooks.push(id);
    }
    chars += end.chars - b.chars;
    words += end.words - b.words;
    pages += end.pages - b.pages;
  }
  return { chars, words, pages, approximated: approxBooks.length > 0, approxBooks, usesLive };
}

// Geschriebene Zeichen diese Woche vs. letzte Woche (Mo-Start, App-Zeitzone),
// beides ueber computeVolumeDelta — dieselbe Basis-Regel wie der Zeitraum.
// Wochengrenzen aus dem App-TZ-Datum von heute per ISO-Tagesarithmetik; mit
// `booksDetail` zaehlt der heutige Live-Stand mit.
export function computeWeeklyDelta(historyRows, todayLocal = new Date(), booksDetail = null) {
  const isoToday = localIsoDate(new Date(todayLocal));
  const monday = isoAddDays(isoToday, -isoDowMon(isoToday));
  const lastMonday = isoAddDays(monday, -7);
  const lastSunday = isoAddDays(monday, -1);
  const opts = { todayIso: isoToday, booksDetail: booksDetail || undefined };
  const thisWeek = computeVolumeDelta(historyRows, monday, null, opts).chars;
  const lastWeek = computeVolumeDelta(historyRows, lastMonday, lastSunday, opts).chars;
  return { thisWeek, lastWeek };
}

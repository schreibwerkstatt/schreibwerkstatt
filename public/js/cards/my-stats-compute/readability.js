// Lesbarkeit aus den Snapshots (book_stats_history). Facade:
// cards/my-stats-compute.js. Regeln: docs/my-stats.md „Lesbarkeit & Wortformen".

import { localIsoDaysAgo } from '../../utils.js';
import { latestSnapshotPerBook, snapshotPerBookOnOrBefore } from './series.js';

// Abstand (Tage) des Vergleichsstands fuer die Trendpfeile (Lesbarkeit, Wortformen).
export const TREND_REF_DAYS = 30;

// Chars-gewichteter Mittelwert eines Feldes ueber eine Snapshot-Map, optional
// nur ueber die Buecher in `onlyIds`.
function weightedAvg(snapMap, field, onlyIds = null) {
  let num = 0, den = 0;
  for (const [id, r] of snapMap) {
    if (onlyIds && !onlyIds.has(id)) continue;
    const v = r[field];
    const w = Number(r.chars) || 0;
    if (v == null || w <= 0) continue;
    num += Number(v) * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

// Buecher, die am Vergleichsstichtag UND heute einen Snapshot haben. Nur ueber
// diese Menge vergleichen — ein seither hinzugekommenes Buch verschoebe den
// Schnitt, ohne dass sich am Schreiben etwas geaendert haette.
export function commonBookIds(latest, past) {
  const ids = new Set();
  for (const id of latest.keys()) if (past.has(id)) ids.add(id);
  return ids;
}

// Lesbarkeit (chars-gewichtet ueber den letzten Snapshot je Buch) + Trend
// gegenueber dem Stand vor TREND_REF_DAYS Tagen (`refIso`), gerechnet ueber die
// Buecher, die zu beiden Zeitpunkten existierten. Trend ∈ {-1,0,1}
// (richtungsneutral — Flesch hoeher = leichter, LIX hoeher = schwerer).
export function computeReadability(historyRows, todayLocal = new Date()) {
  const latest = latestSnapshotPerBook(historyRows);
  const refIso = localIsoDaysAgo(TREND_REF_DAYS, new Date(todayLocal));
  const past = snapshotPerBookOnOrBefore(historyRows, refIso);
  const common = commonBookIds(latest, past);

  const flesch = weightedAvg(latest, 'avg_flesch_de');
  const lix = weightedAvg(latest, 'avg_lix');
  const sentenceLen = weightedAvg(latest, 'avg_sentence_len');
  const hasData = flesch != null || lix != null || sentenceLen != null;

  const trend = (field, eps) => {
    if (!common.size) return 0;
    const cur = weightedAvg(latest, field, common);
    const before = weightedAvg(past, field, common);
    if (cur == null || before == null) return 0;
    const d = cur - before;
    return d > eps ? 1 : d < -eps ? -1 : 0;
  };

  return {
    hasData,
    flesch, lix, sentenceLen,
    refIso,
    trendBooks: common.size,
    fleschTrend:      trend('avg_flesch_de', 1),
    lixTrend:         trend('avg_lix', 1),
    sentenceLenTrend: trend('avg_sentence_len', 0.3),
  };
}

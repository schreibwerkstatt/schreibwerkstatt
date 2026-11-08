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

// Teilmenge einer Snapshot-Map: nur die Buecher in `ids`.
function pick(snapMap, ids) {
  const out = new Map();
  for (const [id, r] of snapMap) if (ids.has(id)) out.set(id, r);
  return out;
}

// Messsprache eines Buchs; fehlt sie (Buch ohne book_settings-Zeile), gilt
// Deutsch — dieselbe Regel wie lib/style-lang.js#styleLanguage.
function langOf(languages, id) {
  return languages?.[id] === 'en' ? 'en' : 'de';
}

// Lesbarkeit EINER Sprache: Wert ueber den letzten Snapshot, Trend gegenueber
// `past` ueber die Buecher, die zu beiden Zeitpunkten existierten.
function readabilityOf(latest, past) {
  const common = commonBookIds(latest, past);
  const trend = (field, eps) => {
    if (!common.size) return 0;
    const cur = weightedAvg(latest, field, common);
    const before = weightedAvg(past, field, common);
    if (cur == null || before == null) return 0;
    const d = cur - before;
    return d > eps ? 1 : d < -eps ? -1 : 0;
  };
  const flesch = weightedAvg(latest, 'avg_flesch_de');
  const lix = weightedAvg(latest, 'avg_lix');
  const sentenceLen = weightedAvg(latest, 'avg_sentence_len');
  return {
    flesch, lix, sentenceLen,
    hasData: flesch != null || lix != null || sentenceLen != null,
    weight: [...latest.values()].reduce((a, r) => a + (Number(r.chars) || 0), 0),
    trendBooks: common.size,
    fleschTrend:      trend('avg_flesch_de', 1),
    lixTrend:         trend('avg_lix', 1),
    sentenceLenTrend: trend('avg_sentence_len', 0.3),
  };
}

// Lesbarkeit (chars-gewichtet ueber den letzten Snapshot je Buch) + Trend
// gegenueber dem Stand vor TREND_REF_DAYS Tagen (`refIso`). Trend ∈ {-1,0,1}
// (richtungsneutral — Flesch hoeher = leichter, LIX hoeher = schwerer).
//
// JE SPRACHE (`languages`: { book_id: 'de'|'en' }): Flesch nach Amstad und nach
// Flesch sind zwei Formeln, und LIX wie Satzlaenge liegen im Englischen
// systematisch tiefer. Ein gemischter Schnitt waere keine der beiden Skalen.
// `groups` ist nach Textmenge sortiert (Hauptsprache zuerst); ein einsprachiges
// Werk hat genau eine Gruppe.
export function computeReadability(historyRows, todayLocal = new Date(), languages = {}) {
  const latest = latestSnapshotPerBook(historyRows);
  const refIso = localIsoDaysAgo(TREND_REF_DAYS, new Date(todayLocal));
  const past = snapshotPerBookOnOrBefore(historyRows, refIso);

  const idsByLang = new Map();
  for (const id of latest.keys()) {
    const lang = langOf(languages, id);
    if (!idsByLang.has(lang)) idsByLang.set(lang, new Set());
    idsByLang.get(lang).add(id);
  }
  const groups = [...idsByLang]
    .map(([language, ids]) => ({ language, ...readabilityOf(pick(latest, ids), pick(past, ids)) }))
    .filter(g => g.hasData)
    .sort((a, b) => b.weight - a.weight);

  return {
    hasData: groups.length > 0,
    multiLanguage: groups.length > 1,
    groups,
    refIso,
  };
}

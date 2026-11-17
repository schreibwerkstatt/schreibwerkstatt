// Jahr×Monat-Heatmap: geteilte, pure Bausteine für das Jahr-als-Zeile × 12-Monate-
// Raster. Konsumenten: Rückblick-Karte (book/tagebuch-rueckblick.js, interaktiv) +
// Buch-Übersicht (book-overview/diary.js, Navigation). CSS-Pattern:
// components/year-month-heatmap.css (.ymheat-*). Siehe DESIGN.md „Jahr×Monat-Heatmap".

import { localIsoDate } from '../utils.js';

// Quartil-Bucketing über positive Zählwerte → `levelFor(n)` ∈ {0..4}.
// Level 0 = keine Einträge; 1..4 = Quartile der positiven Zählwerte. Bei nur
// einer Datenlage kollabieren Stufen — das ist gewollt (wenig Varianz = wenig
// Farbabstufung). Dritter Konsument neben den beiden Jahr×Monat-Heatmaps ist
// das Wochen-Raster [public/js/streak-grid.js] — die Einfärbungs-Regel gilt für
// beide Heatmap-Formen und existiert nur hier.
export function quartileLevelFor(counts) {
  const sorted = [...counts].filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return (e) => {
    if (!e || e <= 0) return 0;
    if (e <= t1) return 1;
    if (e <= t2) return 2;
    if (e <= t3) return 3;
    return 4;
  };
}

// Aktueller Monat als 'YYYY-MM', TZ-aware (app.timezone via localIsoDate) —
// nicht Browser-TZ. Für das „aktueller Monat"-Orientierungs-Highlight der Zellen.
export function currentMonthKey() {
  return localIsoDate().slice(0, 7);
}

// CSS-Klassen einer Zelle aus buildYmHeatRows (Monat oder Jahres-Spalte) —
// beide Konsumenten färben über dieselbe Regel. `activeKey`: gewählter
// Zeitraum des interaktiven Konsumenten (Auswahl-Ring), sonst weglassen.
export function ymHeatCellClass(cell, activeKey = null) {
  return 'ymheat-cell--lvl' + cell.level
    + (cell.isYear ? ' ymheat-cell--year' : '')
    + (cell.hasRueckblick ? ' ymheat-cell--has' : '')
    + (cell.stale ? ' ymheat-cell--stale' : '')
    + (cell.isCurrent ? ' ymheat-cell--current' : '')
    + (activeKey != null && cell.key === activeKey ? ' ymheat-cell--active' : '');
}

// Jahr×Monat-Zeilen aus der serverseitigen Rückblick-Coverage
// (GET /history/rueckblick-coverage, routes/jobs/rueckblick-dates.js
// #buildRueckblickCoverage). Beide Konsumenten — Overview-Heatmap und Kalender
// der Rückblick-Karte — rechnen hier, damit sie dieselben Monate gleich zählen
// und färben. `selectedId` markiert den in der Karte geöffneten Rückblick.
//   → { years: [{ year, yearKey, hasEntries, hasRueckblick, stale, entryId,
//                 yearCreatedAt, selected, months: [12 Zellen], yearCell }],
//       maxEntries, monthsWithEntries, monthsWithRueckblick }
// `yearCell` ist der Jahres-Zeitraum als 13. Zelle in derselben Form wie die
// Monate (Stufe nach Quartil über die Jahre) — das Jahr wird im Kalender wie
// ein Monat gewählt, nicht über einen eigenen Umschalter.
// `stale` (Zelle/Jahr): Rückblick vorhanden, aber Einträge seither geändert —
// berechnet der Server (rueckblickStale), hier nur durchgereicht.
export function buildYmHeatRows(coverage, { selectedId = null } = {}) {
  const empty = { years: [], maxEntries: 0, monthsWithEntries: 0, monthsWithRueckblick: 0 };
  if (!coverage || coverage.minYear == null || coverage.maxYear == null) return empty;
  const months = coverage.months || {};
  const years = coverage.years || {};
  const counts = Object.values(months).map(m => m?.entries || 0).filter(n => n > 0);
  const levelFor = quartileLevelFor(counts);
  const yearLevelFor = quartileLevelFor(Object.values(years).map(y => y?.entries || 0));
  const todayKey = currentMonthKey();
  const isSel = (rb) => !!(rb && selectedId != null && String(rb.id) === String(selectedId));
  const cellFor = (key, entries, rb, level, extra) => ({
    key,
    entries,
    level,
    hasEntries: entries > 0,
    hasRueckblick: !!rb,
    stale: !!rb?.stale,
    entryId: rb?.id ?? null,
    createdAt: rb?.created_at || null,
    selected: isSel(rb),
    ...extra,
  });
  const rows = [];
  let monthsWithEntries = 0;
  let monthsWithRueckblick = 0;
  for (let y = coverage.maxYear; y >= coverage.minYear; y--) {
    const yearKey = String(y);
    const yRb = years[yearKey]?.rueckblick || null;
    const cells = [];
    for (let mi = 1; mi <= 12; mi++) {
      const key = `${yearKey}-${String(mi).padStart(2, '0')}`;
      const entries = months[key]?.entries || 0;
      const rb = months[key]?.rueckblick || null;
      if (entries > 0) monthsWithEntries++;
      if (rb) monthsWithRueckblick++;
      cells.push(cellFor(key, entries, rb, levelFor(entries), { monthIdx: mi, isCurrent: key === todayKey }));
    }
    const yEntries = years[yearKey]?.entries || cells.reduce((n, c) => n + c.entries, 0);
    const yearCell = cellFor(yearKey, yEntries, yRb, yearLevelFor(yEntries),
      { isYear: true, isCurrent: false });
    rows.push({
      year: y,
      yearKey,
      hasEntries: yearCell.hasEntries,
      hasRueckblick: yearCell.hasRueckblick,
      stale: yearCell.stale,
      entryId: yearCell.entryId,
      yearCreatedAt: yearCell.createdAt,
      selected: yearCell.selected,
      months: cells,
      yearCell,
    });
  }
  return {
    years: rows,
    maxEntries: counts.length ? Math.max(...counts) : 0,
    monthsWithEntries,
    monthsWithRueckblick,
  };
}

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

// Jahr×Monat-Zeilen aus der serverseitigen Rückblick-Coverage
// (GET /history/rueckblick-coverage, routes/jobs/rueckblick-dates.js
// #buildRueckblickCoverage). Beide Konsumenten — Overview-Heatmap und Kalender
// der Rückblick-Karte — rechnen hier, damit sie dieselben Monate gleich zählen
// und färben. `selectedId` markiert den in der Karte geöffneten Rückblick.
//   → { years: [{ year, yearKey, hasEntries, hasRueckblick, entryId,
//                 yearCreatedAt, selected, months: [12 Zellen] }], maxEntries }
export function buildYmHeatRows(coverage, { selectedId = null } = {}) {
  const empty = { years: [], maxEntries: 0 };
  if (!coverage || coverage.minYear == null || coverage.maxYear == null) return empty;
  const months = coverage.months || {};
  const years = coverage.years || {};
  const counts = Object.values(months).map(m => m?.entries || 0).filter(n => n > 0);
  const levelFor = quartileLevelFor(counts);
  const todayKey = currentMonthKey();
  const isSel = (rb) => !!(rb && selectedId != null && String(rb.id) === String(selectedId));
  const rows = [];
  for (let y = coverage.maxYear; y >= coverage.minYear; y--) {
    const yearKey = String(y);
    const yRb = years[yearKey]?.rueckblick || null;
    const cells = [];
    for (let mi = 1; mi <= 12; mi++) {
      const key = `${yearKey}-${String(mi).padStart(2, '0')}`;
      const entries = months[key]?.entries || 0;
      const rb = months[key]?.rueckblick || null;
      cells.push({
        key,
        monthIdx: mi,
        entries,
        level: levelFor(entries),
        hasEntries: entries > 0,
        isCurrent: key === todayKey,
        hasRueckblick: !!rb,
        entryId: rb?.id ?? null,
        createdAt: rb?.created_at || null,
        selected: isSel(rb),
      });
    }
    rows.push({
      year: y,
      yearKey,
      hasEntries: (years[yearKey]?.entries || 0) > 0 || cells.some(c => c.hasEntries),
      hasRueckblick: !!yRb,
      entryId: yRb?.id ?? null,
      yearCreatedAt: yRb?.created_at || null,
      selected: isSel(yRb),
      months: cells,
    });
  }
  return { years: rows, maxEntries: counts.length ? Math.max(...counts) : 0 };
}

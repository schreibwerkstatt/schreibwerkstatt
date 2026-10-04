'use strict';
// Perzentil-Definition der Stil-Metriken — EINE Stelle, weil zwei Pfade dieselbe
// Zahl liefern muessen: der Seiten-P90 beim Indexieren
// ([lib/page-index.js](./page-index.js)#computeStyleStats) und der Kapitel-/Buch-P90
// aus den gepoolten Satzlaengen-Sequenzen ([lib/stil-heatmap.js](./stil-heatmap.js),
// [lib/stil-rhythmus.js](./stil-rhythmus.js)). Weichen die Definitionen ab, zeigt ein
// Kapitel aus einer einzigen Seite in der Heatmap einen anderen P90 als die Seite.
//
// Definition: Index `floor((n - 1) * p)` in der aufsteigend sortierten Liste — kein
// Interpolieren, das Ergebnis ist immer ein tatsaechlich vorkommender Wert.

/** Perzentil einer AUFSTEIGEND SORTIERTEN Zahlenliste; `null` bei leerer Liste. */
function percentileSorted(sorted, p) {
  if (!sorted || !sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/** Perzentil einer UNSORTIERTEN Zahlenliste (kopiert + sortiert). */
function percentileOf(values, p) {
  if (!values || !values.length) return null;
  return percentileSorted([...values].sort((a, b) => a - b), p);
}

module.exports = { percentileSorted, percentileOf };

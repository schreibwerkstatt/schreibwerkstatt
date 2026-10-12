// Auswahllisten der Ueberschriften-Gestaltung (Linie/Ornament, Kapitelnummer,
// Ausrichtung) — geteilt von PDF- und EPUB-Karte, gespreadet in beide
// `Alpine.data(...)`. Die Werte sind deckungsgleich mit lib/heading-style.js
// (Server-SSoT, Validierung + Renderer); gegated durch
// tests/unit/heading-style.test.mjs. Labels: `export.heading.<feld>.<wert>`,
// Ausrichtungen gemeinsam unter `export.heading.align.<wert>`.

export const HEADING_STYLE_ENUMS = Object.freeze({
  ruleStyle: ['single', 'double', 'dotted', 'dashed', 'stars', 'asterism', 'diamond', 'dots'],
  ruleWeight: ['hairline', 'thin', 'medium', 'thick'],
  ruleWidth: ['auto', 'short', 'third', 'full'],
  rulePosition: ['below', 'above', 'both'],
  numberPrefix: ['none', 'chapter', 'part', 'custom'],
  numberCase: ['normal', 'uppercase', 'smallcaps'],
  subTitleAlign: ['left', 'center'],
  pageTitleAlign: ['left', 'center'],
});

// Linienarten, bei denen Staerke und Laenge wirken (Linien + Raute mit Linienstuecken).
const SIZED_RULES = ['single', 'double', 'dotted', 'dashed', 'diamond'];

export function headingStyleSlice() {
  return {
    headingStyleOptions(key) {
      const t = window.__app.t;
      const prefix = key === 'subTitleAlign' || key === 'pageTitleAlign' ? 'export.heading.align' : `export.heading.${key}`;
      return HEADING_STYLE_ENUMS[key].map(v => ({ value: v, label: t(`${prefix}.${v}`) }));
    },
    headingRuleIsSized(ruleStyle) {
      return SIZED_RULES.includes(ruleStyle);
    },
  };
}

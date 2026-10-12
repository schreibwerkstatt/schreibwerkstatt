// Mermaid-Palette der App — die EINE Stelle, an der festgelegt wird, wie ein
// Diagramm aussieht.
//
// Drei Renderer lesen sie: der Server (lib/mermaid-render.js, Bildschirm UND
// Export), die Live-Vorschau im Diagramm-Dialog (mermaid-view.js) und der
// Rueckfall im Share-Reader (bewusste Kopie in share-reader/mermaid-theme.js,
// der Reader importiert nichts aus dem App-Bundle). Weicht einer ab, sieht die
// Vorschau anders aus als das gespeicherte Bild.
//
// WARUM HEX-KOPIEN STATT CSS-VARIABLEN: der Server rendert im Headless-Chromium
// ohne App-CSS, und die Farben stehen danach gebacken im SVG. Die Basistoene
// unten sind darum Kopien aus public/css/tokens/colors.css — gegated durch
// tests/unit/mermaid-drift.test.mjs. Getoente Flaechen werden aus ihnen
// GERECHNET, nicht kopiert: die Tokens sind dort rgba-Overlays, die erst auf
// ihrem Untergrund eine Farbe ergeben, und mermaid versteht nur deckende Werte.
//
// DOM-frei: der Server laedt das Modul per `import()` (lib/esm-bridge.js).
//
// Schluessel: 'default' = hell (auch der Export), 'dark' = dunkel.

/** Basistoene je Theme, Name = CSS-Token ohne `--color-`. */
export const MERMAID_TOKENS = {
  default: {
    'page-view-bg': '#fbf8f3',
    'bg': '#faf7f2',
    'surface': '#ffffff',
    'text': '#1f1c18',
    'muted': '#6b6258',
    'faint': '#b8aea2',
    'accent': '#c4a55a',
    'primary-light': '#2d6a9f',
  },
  dark: {
    'page-view-bg': '#1f1d1a',
    'bg': '#1a1816',
    'surface': '#2a2722',
    'text': '#e6e2d9',
    'muted': '#9a948a',
    'faint': '#524d46',
    'accent': '#c9a961',
    'primary-light': '#5a7a99',
  },
};

/** `fg` mit Deckung `alpha` auf `bg` legen → deckender Hex-Wert. */
function mix(fg, bg, alpha) {
  const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(ch(bg, i) + (ch(fg, i) - ch(bg, i)) * alpha);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/** Konfiguration fuer `mermaid.initialize` — wird dort hineingespreadet.
 *
 *  `theme: 'base'` ist das einzige mermaid-Theme, das `themeVariables`
 *  vollstaendig respektiert; alle nicht gesetzten Werte leitet mermaid aus den
 *  gesetzten ab. Knoten tragen die Feder-Gold-Toenung (wie `--color-accent-bg`),
 *  Nebenflaechen das Marken-Blau, Gruppen das Papier. */
export function mermaidThemeConfig(theme) {
  const dark = theme === 'dark';
  const c = MERMAID_TOKENS[dark ? 'dark' : 'default'];
  return {
    theme: 'base',
    themeVariables: {
      darkMode: dark,
      background: c['page-view-bg'],
      fontFamily: 'Inter, system-ui, sans-serif',
      primaryColor: mix(c.accent, c.surface, dark ? 0.18 : 0.16),
      primaryBorderColor: c.accent,
      primaryTextColor: c.text,
      secondaryColor: mix(c['primary-light'], c.surface, dark ? 0.22 : 0.10),
      secondaryBorderColor: c['primary-light'],
      secondaryTextColor: c.text,
      tertiaryColor: c.bg,
      tertiaryBorderColor: c.faint,
      tertiaryTextColor: c.text,
      lineColor: c.muted,
      textColor: c.text,
      titleColor: c.text,
      edgeLabelBackground: c['page-view-bg'],
      clusterBkg: c.bg,
      clusterBorder: c.faint,
      noteBkgColor: mix(c.accent, c.surface, dark ? 0.12 : 0.26),
      noteBorderColor: c.accent,
      noteTextColor: c.text,
    },
  };
}

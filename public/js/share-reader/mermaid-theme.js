// BEWUSSTE KOPIE von public/js/diagram/mermaid-theme.js fuer den Rueckfall im
// Share-Reader: der Reader ist ein eigenstaendiger, schlanker Modulgraph und
// darf nur aus /js/share-reader/ importieren. Inhaltsgleich gehalten durch
// tests/unit/mermaid-drift.test.mjs — Aenderungen IMMER zuerst im Original.
//
// Schluessel: 'default' = hell, 'dark' = dunkel.

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

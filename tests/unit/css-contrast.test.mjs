// Kontrast-Gate fuer die Farb-Tokens (public/css/tokens/colors.css), Light + Dark.
//
// WARUM: die Tokens tragen zwei Rollen, die sich optisch kaum unterscheiden —
// Vollton fuer Flaechen/Raender/Dots (`--color-success`, `--color-accent`,
// Severity-Volltoene) und Schrift (`--color-ok-text`, `--color-accent-text`,
// `--color-*-text`). Ein Vollton als `color:` sieht im Code harmlos aus und
// landet bei 1.9:1 (success auf Weiss). Darum zwei Pruefungen:
//   1. Jede Schrift-Paarung erreicht WCAG AA (4.5:1), jedes Nicht-Text-Signal
//      (Fokus-Rahmen, Fokus-Ring, Zeitleisten-Marker) 3:1 — in BEIDEN Themes.
//   2. Reine Fuell-Tokens stehen nie als `color:`-Wert in public/css.
// Dazu: `<meta name="theme-color">` (index.html) und die Konstanten in
// theme-init.js spiegeln --color-bg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(ROOT, 'public', 'css');
const COLORS = readFileSync(join(CSS_DIR, 'tokens', 'colors.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// --- Token-Parser --------------------------------------------------------------
function block(selectorRe) {
  const m = COLORS.match(selectorRe);
  assert.ok(m, `Block ${selectorRe} nicht gefunden`);
  const start = m.index + m[0].length;
  let depth = 1, i = start;
  while (depth && i < COLORS.length) { if (COLORS[i] === '{') depth++; else if (COLORS[i] === '}') depth--; i++; }
  const out = {};
  for (const d of COLORS.slice(start, i - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const LIGHT = block(/:root\s*\{/);
const DARK = { ...LIGHT, ...block(/:root\[data-theme="dark"\]\s*\{/) };
const THEMES = { light: LIGHT, dark: DARK };

function resolve(map, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Zyklus bei ${name}`);
  seen.add(name);
  const v = map[name];
  assert.ok(v !== undefined, `Token ${name} fehlt`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(map, ref[1], seen) : v;
}

function parseColor(c) {
  let m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error(`Farbe nicht auswertbar: ${c}`);
}
const over = (fg, bg) => [0, 1, 2].map((k) => fg[k] * fg[3] + bg[k] * (1 - fg[3])).concat(1);
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

// Hintergrund-Stapel von unten nach oben (halbtransparente Flaechen liegen auf
// --color-surface), Vordergrund darauf komponiert.
function ratio(map, fgTok, bgToks) {
  let bg = parseColor(resolve(map, '--color-surface'));
  for (const t of bgToks) bg = over(parseColor(resolve(map, t)), bg);
  const fg = over(parseColor(resolve(map, fgTok)), bg);
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// --- 1. Paarungen ----------------------------------------------------------------
const SURFACES = [['--color-bg'], ['--color-surface'], ['--color-page-view-bg']];
const TEXT_TOKENS = [
  '--color-text', '--color-muted', '--color-subtle',
  '--color-ok-text', '--color-warn-text', '--color-err-text',
  '--color-accent-text', '--color-primary',
  '--color-stark-text', '--color-mittel-text', '--color-schwach-text',
  '--color-mark-ins-text', '--color-accent-figure-fg', '--color-accent-location-fg',
];
// Schrift auf eigener Status-Flaeche.
const TEXT_ON = [
  ['--color-ok-text', ['--color-ok-bg']],
  ['--color-warn-text', ['--color-warn-bg']],
  ['--color-err-text', ['--color-err-bg']],
  ['--color-schwach-text', ['--color-schwach-bg']],
  ['--color-accent-text', ['--color-accent-bg']],
  ['--color-mark-del-text', ['--color-mark-del-bg']],
  ['--color-mark-ins-text', ['--color-mark-ins-bg']],
  ['--color-badge-inverse-text', ['--color-badge-inverse-bg']],
  ['--color-on-primary', ['--color-primary']],
  ['--color-text', ['--color-tag-bg']],
  ['--color-tag-text', ['--color-tag-bg']],
  ['--color-tag-text', ['--color-bg', '--color-tag-bg']],
  ['--color-tag-text', ['--color-page-view-bg', '--color-tag-bg']],
];
// Nicht-Text-Signale (WCAG 1.4.11): 3:1 gegen die Flaechen.
const UI_TOKENS = ['--color-border-focus', '--focus-ring-color'];
// Nur Light: die Dark-Werte der Event-Akzente leitet oklch(from …) ab (nicht
// statisch auswertbar), der Lift hellt sie auf dunklem Grund ohnehin auf.
const LIGHT_UI_ONLY = Object.keys(LIGHT).filter((k) => /^--card-accent-event-.*-base$/.test(k));
// Weisse Schrift auf gefuellter Karten-Akzent-Flaeche (Onboarding-Schritt erledigt).
const LIGHT_TEXT_ON = [['--color-on-accent-fill', ['--card-accent-onboarding-base']]];

test('Farb-Tokens: Schrift >= 4.5:1, Fokus-/Marker-Signale >= 3:1 (Light + Dark)', () => {
  const fails = [];
  const check = (theme, map, fg, bgs, min) => {
    const r = ratio(map, fg, bgs);
    if (r < min) fails.push(`${theme}: ${fg} auf ${bgs.join(' + ') || 'surface'} = ${r.toFixed(2)}:1 < ${min}:1`);
  };
  for (const [theme, map] of Object.entries(THEMES)) {
    for (const fg of TEXT_TOKENS) for (const bgs of SURFACES) check(theme, map, fg, bgs, 4.5);
    for (const [fg, bgs] of TEXT_ON) check(theme, map, fg, bgs, 4.5);
    for (const fg of UI_TOKENS) for (const bgs of SURFACES) check(theme, map, fg, bgs, 3);
  }
  for (const fg of LIGHT_UI_ONLY) check('light', LIGHT, fg, [], 3);
  for (const [fg, bgs] of LIGHT_TEXT_ON) check('light', LIGHT, fg, bgs, 4.5);
  assert.equal(fails.length, 0, `Kontrast unter WCAG-Schwelle:\n  ${fails.join('\n  ')}`);
});

// --- 2. Fuell-Tokens nie als Schriftfarbe ---------------------------------------
// Vollton-Tokens, die als Text durchfallen. Fuer Schrift gibt es je ein -text-Pendant.
const FILL_ONLY = {
  '--color-success': '--color-ok-text',
  '--color-accent': '--color-accent-text',
  '--color-faint': '--color-subtle',
  '--color-pending': '--color-warn-text',
  '--color-stark': '--color-stark-text',
  '--color-mittel': '--color-mittel-text',
  '--color-schwach': '--color-schwach-text',
};
// Ausgenommen: tokens/ definiert sie; share/ hat ein eigenes Token-Universum.
const EXCLUDED = ['css/tokens/', 'css/share/', 'css/share.css'];
// Begruendete Einzelfaelle: `datei|selektor-fragment`.
const ALLOW = new Map([]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.css')) out.push(f);
  }
  return out;
}

test('Fuell-Tokens (Vollton) stehen nie direkt als color:-Wert', () => {
  const hits = [];
  const re = new RegExp(`(?<![\\w-])color\\s*:\\s*var\\((${Object.keys(FILL_ONLY).join('|')})\\)`, 'g');
  for (const f of walk(CSS_DIR)) {
    const r = relative(join(ROOT, 'public'), f).split('\\').join('/');
    if (EXCLUDED.some((e) => r.startsWith(e))) continue;
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      if ([...ALLOW.keys()].some((k) => k === `${r}|${line}`)) continue;
      hits.push(`${r}:${line} color: var(${m[1]}) — als Schrift ${FILL_ONLY[m[1]]} nehmen`);
    }
  }
  assert.equal(hits.length, 0, `Fuell-Token als Schriftfarbe:\n  ${hits.join('\n  ')}`);
});

// Die Tag-Flaeche hellt im Dark-Theme auf und drueckt muted/subtle unter 4.5:1;
// Sekundaerschrift darauf ist --color-tag-text (im selben Regelblock geprueft).
test('Schrift auf --color-tag-bg ist --color-tag-text, nie muted/subtle', () => {
  const hits = [];
  for (const f of walk(CSS_DIR)) {
    const r = relative(join(ROOT, 'public'), f).split('\\').join('/');
    if (EXCLUDED.some((e) => r.startsWith(e))) continue;
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
      if (!/(?<![\w-])background(?:-color)?\s*:\s*var\(--color-tag-bg\)/.test(m[1])) continue;
      const c = m[1].match(/(?<![\w-])color\s*:\s*var\((--color-(?:muted|subtle))\)/);
      if (c) hits.push(`${r}:${src.slice(0, m.index).split('\n').length} color: var(${c[1]}) — --color-tag-text nehmen`);
    }
  }
  assert.equal(hits.length, 0, `Sekundaerschrift auf Tag-Flaeche:\n  ${hits.join('\n  ')}`);
});

// --- 3. Browser-Leiste = Tischflaeche -------------------------------------------
test('theme-color (index.html + theme-init.js) spiegelt --color-bg', () => {
  const light = resolve(LIGHT, '--color-bg').toLowerCase();
  const dark = resolve(DARK, '--color-bg').toLowerCase();
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const metas = [...html.matchAll(/<meta name="theme-color" content="([^"]+)" media="\(prefers-color-scheme: (light|dark)\)">/g)];
  assert.equal(metas.length, 2, 'index.html: zwei theme-color-Metas (light + dark) erwartet');
  for (const [, color, scheme] of metas) {
    assert.equal(color.toLowerCase(), scheme === 'dark' ? dark : light, `theme-color ${scheme} ≠ --color-bg`);
  }
  const init = readFileSync(join(ROOT, 'public', 'js', 'theme-init.js'), 'utf8');
  const m = init.match(/THEME_COLOR = \{ light: '([^']+)', dark: '([^']+)' \}/);
  assert.ok(m, 'theme-init.js: THEME_COLOR-Konstante nicht gefunden');
  assert.deepEqual([m[1].toLowerCase(), m[2].toLowerCase()], [light, dark], 'theme-init.js THEME_COLOR ≠ --color-bg');
});

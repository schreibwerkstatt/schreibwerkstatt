// Ratsche fuer die Schriftgroessen-Skala (tokens/typography.css): `font-size`
// kommt aus `--font-size-*` (bzw. `--font-em-*` / `em` fuer schrift-relative
// Groessen), nicht als roher px-/rem-Wert.
//
// WARUM: dieselbe Drift wie bei den Abstaenden (spacing-scale.test.mjs) — ein
// roher Wert liegt auf keiner Stufe der Skala und taucht darum in keiner
// Nachbarkarte wieder auf. Die geteilte Owner-Karte „Geteilte Links" trug 16
// rohe Groessen, waehrend die Skala dieselben Werte als Token anbot.
//
// Modell wie loc-limits / spacing-scale: harte Regel + Allowlist der
// bestehenden Ueberschreiter als Ratschen-Ceiling (nur runter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const rel = (p) => relative(join(REPO_ROOT, 'public'), p).split('\\').join('/');

// Ausgenommen — mit Begruendung:
//   tokens/          definiert die Skala.
//   share/*          eigenes Token-Set ohne Typo-Tokens (pre-auth Reader).
//   landing.css      eigenstaendige Marketing-Seite ausserhalb der App-Shell.
const EXCLUDED = ['css/tokens/', 'css/share/', 'css/share.css', 'css/landing.css'];

// Bestehende Ueberschreiter: Zahl = aktueller Stand (Ratsche, nur runter).
const ALLOW = {
  'css/book-overview/domain.css': 1,          // Hero-Zahl 20px zwischen lg und xl
  'css/book/pdf-export.css': 1,
  'css/components/comment-rail.css': 7,       // share-erreichbar (DESIGN.md Regel 2): Share-Reader kennt keine Typo-Tokens
  'css/components/icons.css': 1,              // share-erreichbar, s. o.
  'css/entities/figur-werkstatt.css': 1,
  'css/page/page-revision-viewer.css': 2,
  'css/page/page-view.css': 1,                // 700px ist der Divisor der Container-Zoom-Formel, keine Groesse
};

const PROP_RE = /(?<![\w-])font-size\s*:\s*([^;{}]+);/g;
const VAL_RE = /(?<![\w.\-])-?(\d*\.?\d+)(rem|px)(?![\w-])/g;
// Fallback in `var(--token, 11px)` zaehlt nicht — der Wert gilt nur dort, wo
// das Token fehlt (Share-Reader-Module).
const stripVarFallbacks = (v) => {
  let prev;
  do { prev = v; v = v.replace(/var\(--[\w-]+(?:\s*,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g, 'TOKEN'); } while (v !== prev);
  return v;
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

export function rawFontSizes(src) {
  const css = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const hits = [];
  for (const m of css.matchAll(PROP_RE)) {
    for (const v of stripVarFallbacks(m[1]).matchAll(VAL_RE)) {
      hits.push(`Zeile ${css.slice(0, m.index).split('\n').length}: font-size: … ${v[0]}`);
    }
  }
  return hits;
}

test('Schriftgroessen kommen aus der Token-Skala (Ratsche fuer rohe px-/rem-Werte)', () => {
  const violations = [];
  const seen = new Set();
  for (const file of walk(CSS_DIR)) {
    const r = rel(file);
    if (EXCLUDED.some((e) => r.startsWith(e))) continue;
    const hits = rawFontSizes(readFileSync(file, 'utf8'));
    const ceiling = ALLOW[r];
    if (ceiling === undefined) {
      if (hits.length) {
        violations.push(`${r}: ${hits.length} rohe Schriftgroesse — Token aus tokens/typography.css ` +
          `nehmen (--font-size-* / --font-em-*):\n      ${hits.join('\n      ')}`);
      }
      continue;
    }
    seen.add(r);
    if (hits.length > ceiling) {
      violations.push(`${r}: ${hits.length} rohe Schriftgroessen > Ceiling ${ceiling} — Altlast darf nur schrumpfen:\n      ${hits.join('\n      ')}`);
    } else if (hits.length < ceiling) {
      violations.push(`${r}: nur noch ${hits.length} statt ${ceiling} — Ceiling nachziehen (oder Eintrag streichen, wenn 0).`);
    }
  }
  for (const r of Object.keys(ALLOW)) {
    if (seen.has(r)) continue;
    violations.push(existsSync(join(REPO_ROOT, 'public', r))
      ? `${r}: keine rohen Schriftgroessen mehr — Allowlist-Eintrag entfernen.`
      : `${r}: Allowlist-Eintrag verweist auf geloeschte Datei — Eintrag entfernen.`);
  }
  assert.equal(violations.length, 0, `Schriftgroessen-Skala verletzt:\n  ${violations.join('\n  ')}`);
});

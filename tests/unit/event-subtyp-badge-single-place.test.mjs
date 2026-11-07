// Gate fuer die Ereignistyp-Anzeige: ein Subtyp erscheint im UI nur als
// `.gz-subtyp-badge` mit Varianten-Klasse `gz-subtyp-badge--<subtyp>` —
// dieselbe Farbe und dasselbe Icon in Ereignisse-Karte, «Im Buch»,
// Referenz-Slot, Lebenslauf und Palette. Farb-SSoT: `--card-accent-event-*`
// (tokens/colors.css), Mapping in css/entities/ereignisse-subtyp.css; dass
// jeder Subtyp dort eine Badge-Variante hat, prueft event-subtyp-drift.test.mjs.
//
// Geprueft wird:
//   1. Jede Stelle in den Templates, die das Subtyp-Label rendert
//      (`events.subtyp.…` bzw. ein `…SubtypLabel(…)`-Helfer), steht in einem
//      `.gz-subtyp-badge` — kein graues `.tag`, kein nackter Text. Ausnahme:
//      Auswahllisten (Combobox-`options`), die Labels nur als Optionen fuehren.
//   2. Jedes `.gz-subtyp-badge` traegt eine Varianten-Klasse, die in
//      ereignisse-subtyp.css `--gz-subtyp-color` setzt (`gz-subtyp-badge--<subtyp>`
//      fuer Ereignisse, `figur-cv-station--<art>` fuer Lebenslauf-Stationen) —
//      ohne sie steht das Badge ausserhalb eines `.gz-item` in der
//      Fallback-Farbe da.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const MAPPING_CSS = join(REPO_ROOT, 'public', 'css', 'entities', 'ereignisse-subtyp.css');
const rel = (p) => relative(REPO_ROOT, p);

// Wie weit ueber der Label-Zeile das umschliessende Badge stehen darf
// (Badge-Oeffnung → Icon → Label).
const BADGE_LOOKBACK = 4;

const LABEL_RE = /events\.subtyp\.|SubtypLabel\(/;
// Combobox-Optionen: Labels als Auswahl, kein angezeigter Typ eines Ereignisses.
const OPTIONS_RE = /\boptions\s*=/;

function templateFiles() {
  const files = readdirSync(PARTIALS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => join(PARTIALS_DIR, f));
  files.push(INDEX_HTML);
  return files;
}

test('Subtyp-Label erscheint nur in einem .gz-subtyp-badge', () => {
  const offenders = [];
  for (const file of templateFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!LABEL_RE.test(line) || OPTIONS_RE.test(line)) return;
      const window = lines.slice(Math.max(0, i - BADGE_LOOKBACK), i + 1).join('\n');
      if (!/\bgz-subtyp-badge\b(?!--)/.test(window)) {
        offenders.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'Ereignistyp ausserhalb von .gz-subtyp-badge gerendert — Badge-Markup aus '
    + 'public/partials/ereignisse.html übernehmen:\n' + offenders.join('\n'));
});

// Praefixe der Varianten-Klassen, die im Mapping eine Farbe setzen — aus der
// CSS gelesen, damit eine neue Badge-Familie dort und nur dort angemeldet wird.
function colorVariantPrefixes() {
  const css = readFileSync(MAPPING_CSS, 'utf8');
  const prefixes = new Set();
  for (const rule of css.matchAll(/([^{}]+)\{[^{}]*--gz-subtyp-color\s*:/g)) {
    for (const cls of rule[1].matchAll(/\.([a-z][\w-]*--)[\w-]+/g)) prefixes.add(cls[1]);
  }
  return [...prefixes];
}

test('Jedes .gz-subtyp-badge traegt eine Farb-Variante aus dem Mapping', () => {
  const prefixes = colorVariantPrefixes();
  assert.ok(prefixes.includes('gz-subtyp-badge--'), 'Mapping ohne gz-subtyp-badge-- — Parser kaputt?');
  const offenders = [];
  for (const file of templateFiles()) {
    const src = readFileSync(file, 'utf8');
    // Oeffnende Tags, deren class-Attribut das Badge (nicht nur Icon) traegt.
    const tagRe = /<[a-z][^>]*\bclass="[^"]*\bgz-subtyp-badge\b(?!--)[^"]*"[^>]*>/g;
    for (const m of src.matchAll(tagRe)) {
      if (!prefixes.some(p => m[0].includes(`'${p}`) || m[0].includes(` ${p}`) || m[0].includes(`"${p}`))) {
        const lineNo = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel(file)}:${lineNo}  ${m[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'gz-subtyp-badge ohne Farb-Variante (erlaubt: ' + prefixes.join(', ') + '):\n'
    + offenders.join('\n'));
});

// Drift guard: jedes Buchtyp-Literal, das der Code zum Feature-Gating
// hartkodiert (buchtyp === 'X', requiresBuchtyp: 'X', der SSoT-Guard in
// lib/buchtyp.js), MUSS als Key in prompt-config.json `buchtypen` (de UND en)
// existieren. Sonst bricht ein Config-Rename eines Buchtyp-Keys die Gates
// lautlos (Blog-Sync, Tagebuch-Kalender, Kurzgeschichten-Prompt).
//
// Quelle der Wahrheit für Buchtyp-Keys ist prompt-config.json; der Code darf
// nur Keys vergleichen, die es dort gibt.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function loadConfigKeys() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'prompt-config.json'), 'utf8'));
  const de = new Set(Object.keys(cfg.buchtypen?.de || {}));
  const en = new Set(Object.keys(cfg.buchtypen?.en || {}));
  return { de, en };
}

// Rekursiv .js/.mjs/.html sammeln (vendor/node_modules ausgenommen).
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// Buchtyp-Literale aus Vergleichs-/Gate-Kontexten ziehen.
// `typeof x.buchtyp === 'function'`-Guards sind keine Buchtyp-Wertvergleiche.
const TYPEOF_LITERALS = new Set([
  'function', 'string', 'number', 'object', 'undefined', 'boolean', 'symbol', 'bigint',
]);

const PATTERNS = [
  // <…>buchtyp<…>  ===|!==|==|!=  'literal'   (Identifier enthält "buchtyp")
  /\b\w*[bB]uchtyp\w*\b[^'"\n]{0,8}(?:===|!==|==|!=)\s*'([a-z_]+)'/g,
  // 'literal'  ===|!==|==|!=  <…>buchtyp<…>   (umgekehrte Schreibweise)
  /'([a-z_]+)'\s*(?:===|!==|==|!=)[^'"\n]{0,8}\b\w*[bB]uchtyp\w*\b/g,
  // requiresBuchtyp: 'literal'  (feature-registry Gate)
  /requiresBuchtyp\s*:\s*'([a-z_]+)'/g,
];

function collectReferencedKeys() {
  const files = [
    ...walk(join(ROOT, 'routes'), ['.js']),
    ...walk(join(ROOT, 'lib'), ['.js']),
    ...walk(join(ROOT, 'public', 'js'), ['.js', '.mjs']),
    ...walk(join(ROOT, 'public', 'partials'), ['.html']),
  ];
  const refs = []; // { key, file }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) {
        if (TYPEOF_LITERALS.has(m[1])) continue;
        refs.push({ key: m[1], file: file.slice(ROOT.length + 1) });
      }
    }
  }
  // SSoT-Literal aus lib/buchtyp.js explizit dazu (steht dort als const, nicht
  // in Vergleichs-Syntax — würde sonst durch die Patterns rutschen).
  const require = createRequire(import.meta.url);
  const { BUCHTYP_BLOG } = require(join(ROOT, 'lib', 'buchtyp.js'));
  refs.push({ key: BUCHTYP_BLOG, file: 'lib/buchtyp.js' });
  return refs;
}

test('buchtyp: de- und en-Keysets sind deckungsgleich', () => {
  const { de, en } = loadConfigKeys();
  const onlyDe = [...de].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !de.has(k));
  assert.deepEqual(onlyDe, [], `Buchtyp-Keys nur in de: ${onlyDe.join(', ')}`);
  assert.deepEqual(onlyEn, [], `Buchtyp-Keys nur in en: ${onlyEn.join(', ')}`);
});

test('buchtyp: jedes hartkodierte Code-Literal existiert in prompt-config.json (de+en)', () => {
  const { de, en } = loadConfigKeys();
  const refs = collectReferencedKeys();

  // Selbsttest: der Scan muss die bekannten Gates wirklich finden — sonst
  // würde der Test bei kaputtem Regex vacuously grün.
  const found = new Set(refs.map((r) => r.key));
  for (const expected of ['blog', 'tagebuch', 'kurzgeschichten']) {
    assert.ok(found.has(expected), `Scan hat das erwartete Gate-Literal '${expected}' nicht gefunden — Regex/Pfade prüfen.`);
  }

  const offenders = refs.filter((r) => !de.has(r.key) || !en.has(r.key));
  assert.deepEqual(
    offenders,
    [],
    `Code referenziert Buchtyp-Keys, die nicht (in beiden Sprachen) in prompt-config.json existieren:\n` +
      offenders.map((o) => `  '${o.key}' in ${o.file}`).join('\n')
  );
});

test('buchtyp: Schulweg-Ausschlussliste nennt nur bekannte Buchtypen', async () => {
  const { de, en } = loadConfigKeys();
  const { SCHULWEG_OHNE_BUCHTYPEN } = await import(join(ROOT, 'public', 'js', 'book', 'school-path.js'));
  const unbekannt = SCHULWEG_OHNE_BUCHTYPEN.filter((k) => !de.has(k) || !en.has(k));
  assert.deepEqual(unbekannt, [], `SCHULWEG_OHNE_BUCHTYPEN kennt: ${unbekannt.join(', ')}`);
});

test('buchtyp: Palette-Sprung «Bucheinstellungen: Schule» fehlt genau bei SCHULWEG_OHNE_BUCHTYPEN', async () => {
  const { SCHULWEG_OHNE_BUCHTYPEN } = await import(join(ROOT, 'public', 'js', 'book', 'school-path.js'));
  const { ACTIONS } = await import(join(ROOT, 'public', 'js', 'cards', 'feature-registry.js'));
  const eintrag = ACTIONS.find((a) => a.key === 'action.bookSettings.school');
  assert.ok(eintrag, 'action.bookSettings.school fehlt in der Feature-Registry');
  assert.deepEqual([...eintrag.hiddenForBuchtyp].sort(), [...SCHULWEG_OHNE_BUCHTYPEN].sort());
});

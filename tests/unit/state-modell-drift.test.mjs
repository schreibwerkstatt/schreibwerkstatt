// Drift guard: docs/state-modell.md MUSS mit public/js/app/app-state.js matchen.
//
// CLAUDE.md erklaert die Doku zur "verbindlichen, drift-gepflegten SSoT" fuer die
// gesamte Alpine-State-Architektur und verlangt das Update im selben Commit.
// Bisher war das nur Prosa: alle uebrigen SSoT-Dokumente haben ein Gate
// (erd-drift, sw-manifest-drift, lektorat-typen-drift, textsorten-drift, ...),
// state-modell.md war das einzige ohne — und driftete entsprechend (Slice-Zahl
// stand auf 21 bei 16 Slices, ein nach $store.collab migrierter Slice stand
// weiter als lebender Root-Slice in der Tabelle).
//
// Geprueft wird die Slice-Schicht, weil sie maschinell entscheidbar ist:
//   1. Die Slice-Anzahl in der Prosa ("spreadet **N** Slice-Funktionen").
//   2. Set-Gleichheit: jeder von initialLektoratState() gespreadete Slice hat
//      eine LEBENDE Tabellenzeile, und jede lebende Zeile existiert im Code.
//   3. Durchgestrichene (~~migrierte~~) Zeilen duerfen NICHT mehr gespreadet
//      werden — sonst behauptet die Doku eine Migration, die nicht stattfand.
//
//   4. Feld-Inventar: jedes Feld eines Slices (und jeder Fremd-Spread wie
//      `...actionMenuState()`) steht mit seinem vollen Namen in der Zeile
//      seines Slices. Gruppierungen und Begruendungen bleiben Prosa — aber
//      ein Feld, das in keiner Zeile auftaucht, ist fuer Leser unsichtbar.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DOC = join(ROOT, 'docs', 'state-modell.md');
const STATE = join(ROOT, 'public', 'js', 'app', 'app-state.js');

/** Slices, die initialLektoratState() tatsaechlich spreadet — in Code-Reihenfolge. */
function codeSlices(src) {
  const start = src.indexOf('export function initialLektoratState');
  assert.notEqual(start, -1, 'initialLektoratState() nicht in app-state.js gefunden.');
  const body = src.slice(start);
  return [...body.matchAll(/\.\.\.(\w+)\(\)/g)].map(m => m[1]);
}

/** Die Slice-Tabelle der Doku: lebende vs. als migriert durchgestrichene Zeilen. */
function docSlices(md) {
  const live = new Set();
  const struck = new Set();
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1];
    if (cell === undefined) continue;
    const label = cell.trim();
    if (!label || label === 'Slice' || /^-+$/.test(label)) continue;
    // Eine Zelle kann mehrere Slices nennen: `a` / `b` bzw. ~~`a` / `b`~~.
    const names = [...label.matchAll(/`(\w+State)`/g)].map(m => m[1]);
    if (!names.length) continue;
    const isStruck = label.includes('~~');
    for (const n of names) (isStruck ? struck : live).add(n);
  }
  return { live, struck };
}

/** Die in der Prosa behauptete Slice-Anzahl. Bold darf die Zahl allein oder
 *  samt Wort umfassen (`**16** Slice-Funktionen` / `**16 Slice-Funktionen**`). */
function docSliceCount(md) {
  const m = md.match(/spreadet\s+\*\*(\d+)(?:\*\*)?\s+Slice-Funktionen/);
  return m ? Number(m[1]) : null;
}

const md = readFileSync(DOC, 'utf8');
const src = readFileSync(STATE, 'utf8');
const slices = codeSlices(src);

test('state-modell.md: behauptete Slice-Anzahl matcht app-state.js', () => {
  const claimed = docSliceCount(md);
  assert.notEqual(
    claimed, null,
    'Satz "spreadet **N** Slice-Funktionen" fehlt in docs/state-modell.md — das Gate braucht ihn als Anker.'
  );
  assert.equal(
    claimed, slices.length,
    `docs/state-modell.md behauptet ${claimed} Slices, initialLektoratState() spreadet ${slices.length}. `
    + 'Zahl im Satz ueber der Tabelle nachziehen.'
  );
});

test('state-modell.md: jeder Code-Slice hat eine lebende Tabellenzeile', () => {
  const { live, struck } = docSlices(md);
  const missing = slices.filter(s => !live.has(s));
  assert.deepEqual(
    missing, [],
    `Slices ohne lebende Zeile in der Slice-Tabelle: ${missing.join(', ')}. `
    + 'Neuer Slice → Zeile ergaenzen (Regel "Doku im selben Commit aktualisieren").'
  );
  // Ein Slice, der als migriert durchgestrichen ist, aber weiter gespreadet
  // wird: die Doku behauptet eine Migration, die nicht stattgefunden hat.
  const lying = slices.filter(s => struck.has(s));
  assert.deepEqual(
    lying, [],
    `Als migriert (~~durchgestrichen~~) dokumentiert, aber weiter von initialLektoratState() `
    + `gespreadet: ${lying.join(', ')}. Entweder Migration nachziehen oder Zeile reaktivieren.`
  );
});

test('state-modell.md: keine lebende Tabellenzeile ohne Code-Slice', () => {
  const { live } = docSlices(md);
  const set = new Set(slices);
  const stale = [...live].filter(s => !set.has(s));
  assert.deepEqual(
    stale, [],
    `Slice-Tabelle listet Slices, die app-state.js nicht mehr spreadet: ${stale.join(', ')}. `
    + 'Migrierten Slice ~~durchstreichen~~ + neues Zuhause nennen, nicht als lebenden Slice stehen lassen.'
  );
});

/** Felder je Slice-Funktion: { sliceName: [feld | 'spread:fooState'] }. */
function codeSliceFields(src) {
  const sf = ts.createSourceFile(STATE, src, ts.ScriptTarget.Latest, true);
  const unwrap = (e) => { while (e && ts.isParenthesizedExpression(e)) e = e.expression; return e; };
  const out = {};
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer;
      if (!init || !ts.isArrowFunction(init) || !ts.isIdentifier(d.name)) continue;
      let body = unwrap(init.body);
      if (body && ts.isBlock(body)) body = unwrap(body.statements.find(ts.isReturnStatement)?.expression);
      if (!body || !ts.isObjectLiteralExpression(body)) continue;
      out[d.name.text] = body.properties.map(p => ts.isSpreadAssignment(p)
        ? 'spread:' + p.expression.getText().replace(/\(.*$/, '')
        : p.name.getText());
    }
  }
  return out;
}

/** Text der lebenden Tabellenzeile eines Slices. */
function docRow(md, slice) {
  return md.split('\n').find(l => l.startsWith('|') && !l.includes('~~')
    && (l.split('|')[1] || '').includes('`' + slice + '`')) || '';
}

test('state-modell.md: jedes Slice-Feld steht in der Zeile seines Slices', () => {
  const fields = codeSliceFields(src);
  const missing = [];
  for (const slice of slices) {
    const row = docRow(md, slice);
    for (const f of fields[slice] || []) {
      const name = f.startsWith('spread:') ? f.slice(7) : f;
      // Karten-Sichtbarkeit: Inventar ist EXCLUSIVE_CARDS (feature-registry.js),
      // die Zeile nennt sie summarisch als `showXxxCard`-Flags.
      if (slice === 'cardsState' && /^show\w+Card$/.test(name)) continue;
      const re = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
      if (!re.test(row)) missing.push(`${slice}.${name}`);
    }
  }
  assert.deepEqual(
    missing, [],
    `Felder ohne Nennung in ihrer Slice-Zeile (vollen Feldnamen in die Zeile, Kurzformen wie a/B/C zaehlen nicht):\n  ${missing.join('\n  ')}`
  );
});

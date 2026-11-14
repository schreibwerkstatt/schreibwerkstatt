// Gate fuer den Werkstatt-Bedienvertrag (DESIGN.md „Werkstatt-Bedienvertrag"):
// dieselbe Absicht hat in jeder Werkstatt denselben Weg.
//
// Geprueft wird:
//   1. Jede Eintrags-Darstellung einer Werkstatt (Board-Karte, Katalog-Zeile,
//      Listen-Zeile) traegt ein Aktionsmenue: `@contextmenu` (das
//      action-menu-Gate erzwingt daneben `x-long-press` und die Mechanik).
//   2. KI-Vorschlaege haben keine Eigenoptik: kein CSS-Selektor
//      `.<feature>-vorschlag/-vorschlaege/-suggestion(s)` ausserhalb von
//      components/chat-vorschlag.css — ausser begruendet in ALLOW.
//   3. Mehrfachauswahl hat keinen Auswahl-Modus (`bulkMode`, `toggleBulkMode`):
//      die Haken stehen immer, die Leiste erscheint ab der ersten Markierung.
//   4. Undo/Redo laeuft ueber den Kern cards/board-history.js: niemand sonst
//      schiebt auf `_undoStack`/`_redoStack` oder definiert `historyUndo`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const rel = (f) => relative(ROOT, f);
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'vendor') walk(full, ext, out); }
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// Partials, die Werkstatt-Eintraege rendern. Neue Werkstatt → Zeile ergaenzen.
const ENTRY_PARTIALS = [
  'figuren', 'orte-list', 'szenen', 'ereignisse', 'world-facts', 'sources',
  'ideen', 'ideen-board-grid', 'ideen-board-list',
  'recherche-item', 'recherche-status-board',
  'plot-beat-cell', 'plot-board-grid', 'plot-board-flat',
  'motiv-tree', 'motiv-tree-motifs', 'motiv-outline',
  'szenen-grid', 'orte-grid',
  'titelwerkstatt', 'figur-werkstatt',
].map(n => `public/partials/${n}.html`);

test('jeder Werkstatt-Eintrag hat ein Aktionsmenue', () => {
  const missing = ENTRY_PARTIALS.filter(f => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, [], 'Partial der Liste existiert nicht mehr — ENTRY_PARTIALS nachziehen');
  const bad = ENTRY_PARTIALS.filter(f => !/@contextmenu/.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(bad, [], 'Eintraege ohne Aktionsmenue (⋯ + Rechtsklick + Long-Press, DESIGN.md «Werkstatt-Bedienvertrag»)');
});

const OWNER = 'public/css/components/chat-vorschlag.css';
// Klasse → Grund. Nur, was KEIN uebernehmbarer KI-Vorschlag ist oder nur Abstand traegt.
const ALLOW = {
  'chat-idee-vorschlaege': 'nur Abstand der Vorschlagsliste in der Chat-Bubble',
  'tag-input-suggestion': 'Autovervollstaendigung der Schlagwort-Eingabe, kein KI-Vorschlag',
  'plot-zeit-vorschlag': 'Sammel-Review der Zeitangaben mit «alle übernehmen» — Review-Muster (DESIGN.md «Auswahl-Leiste», Abgrenzung)',
  'plot-zeit-vorschlag-warn': 'Teil des Zeit-Reviews',
  'plot-konflikt-vorschlag': 'Empfehlungstext eines Konsistenz-Befunds, nichts zu übernehmen',
  'motiv-suggestions': 'nur Abstand des Containers um die .chat-vorschlaege',
  'research-suggestions': 'Rahmen des wegklickbaren Vorschlags-Panels; die Eintraege darin sind .chat-vorschlag',
};

test('KI-Vorschlaege ohne Eigenoptik', () => {
  const re = /\.((?:[a-z0-9]+-)+(?:vorschlag|vorschlaege|suggestion|suggestions)(?:-[a-z0-9-]+)?)\b/g;
  const bad = [];
  for (const f of walk(join(ROOT, 'public/css'), '.css')) {
    if (rel(f) === OWNER) continue;
    for (const m of stripCss(readFileSync(f, 'utf8')).matchAll(re)) {
      const cls = m[1];
      if (cls.startsWith('chat-vorschlag')) continue; // eigene Klassen des Musters, gegated in chat-vorschlag-single-place
      if (!(cls in ALLOW)) bad.push(`${rel(f)}: .${cls}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], 'eigene Vorschlagsoptik — .chat-vorschlag nehmen (DESIGN.md «Chat-Vorschlagskarte»)');
});

const jsFiles = walk(join(ROOT, 'public/js'), '.js');

test('Mehrfachauswahl ohne Auswahl-Modus', () => {
  const htmlFiles = walk(join(ROOT, 'public/partials'), '.html');
  const bad = [...jsFiles, ...htmlFiles]
    .filter(f => /\b(?:bulkMode|toggleBulkMode|selectionMode)\b/.test(stripJs(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(bad, [], 'Auswahl-Modus gefunden — Haken immer, Leiste ab der ersten Markierung');
});

test('Undo/Redo nur ueber cards/board-history.js', () => {
  const CORE = 'public/js/cards/board-history.js';
  const re = /_(?:undo|redo)Stack\.push\(|\bhistory(?:Undo|Redo)\s*\([^)]*\)\s*\{/;
  const bad = jsFiles.filter(f => rel(f) !== CORE && re.test(stripJs(readFileSync(f, 'utf8')))).map(rel);
  assert.deepEqual(bad, [], 'eigener Undo-Treiber — boardHistoryState()/boardHistoryMethods spreaden');
});

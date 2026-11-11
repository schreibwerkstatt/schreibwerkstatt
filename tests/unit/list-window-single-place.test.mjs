// Katalog-Listen rendern schrittweise (public/js/list-window.js, Regel in
// public/CLAUDE.md „Katalog-Listen schrittweise"). Eine Zeile mit Entitäts-
// Referenzen kostet Alpine Millisekunden; ein grosses Buch trägt Hunderte
// Schauplätze/Figuren/Ereignisse, und ohne Fenster blockiert das Öffnen der Karte
// Sekunden den Main-Thread. Tabellen über `sortableTable` haben das Fenster
// eingebaut und sind hier nicht Thema.
//
// Geprueft wird:
//   1. Jedes `x-for` über eine Quelle aus CATALOG_LISTS läuft durch
//      `listWindowed(…)` — eine Schleife über die nackte Quelle ist rot.
//   2. Jede Quelle aus CATALOG_LISTS kommt mindestens einmal gefenstert vor
//      (sonst ist der Eintrag tot oder umbenannt).
//   3. Ein `x-for` direkt über `$store.catalog.*` (auch mit `.filter(…)`) ist
//      gefenstert oder steht begründet in ALLOW — so fällt eine neue Katalog-
//      Liste auf, bevor sie in CATALOG_LISTS steht.
//   4. Jedes gefensterte `x-for` hat in derselben Datei seinen «Weitere
//      anzeigen»-Knopf (`listWindowRest(` + `x-list-more`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS = join(REPO_ROOT, 'public', 'partials');

// Ausdrücke, die eine Katalog-Liste einer Karte liefern (gefiltert + sortiert).
const CATALOG_LISTS = [
  'orteFiltered',          // Schauplätze: Liste + Locate-Liste der Geo-Karte
  'filteredFiguren()',     // Figuren
  'szenenFiltered',        // Szenen
  'songsFiltered',         // Musik
  'filteredEreignisse()',  // Ereignisse
  'g.fakten',              // Weltfakten (Fenster je Kategorie)
  'referenceFiguren()',    // Referenz-Slot neben dem Notebook-Editor (Buch-Scope = ganzer Katalog)
  'referenceOrte()',
  'referenceSzenen()',
  'referenceEreignisse()',
  'referenceWeltfaktenItems()',
];

// `datei:ausdruck` → Begründung. Nur Schleifen, die nie buchgross werden.
const ALLOW = {
  'ereignisse.html:($store.catalog.zeitstrahlChronology?.chapters || [])': 'Kapitel-Achse des Zeitstrahls — eine Zeile je Kapitel, nicht je Ereignis',
  'orte-detail.html:$store.catalog.szenen.filter(s => (s.ort_ids||[]).includes(o.id))': 'Szenen an einem einzelnen Ort, im aufgeklappten Detail',
};

const files = readdirSync(PARTIALS).filter(f => f.endsWith('.html'));
const loops = [];
for (const f of files) {
  const src = readFileSync(join(PARTIALS, f), 'utf8');
  for (const m of src.matchAll(/x-for="\(?\s*[\w$]+(?:\s*,\s*[\w$]+)*\s*\)?\s+in\s+([^"]+)"/g)) {
    loops.push({ file: f, expr: m[1].trim(), src });
  }
}

const isWindowed = (expr) => expr.startsWith('listWindowed(');
const windowArg = (expr) => expr.replace(/^listWindowed\(/, '').replace(/\)$/, '').split(/,\s*(?![^()]*\))/)[0].trim();

test('x-for über eine Katalog-Liste läuft durch listWindowed', () => {
  const bad = loops.filter(l => CATALOG_LISTS.includes(l.expr)).map(l => `${l.file}: x-for über ${l.expr}`);
  assert.deepEqual(bad, [], `Katalog-Liste ohne Fenster — listWindowed(…) + «Weitere anzeigen» (list-window.js):\n${bad.join('\n')}`);
});

test('jede Katalog-Liste kommt gefenstert vor', () => {
  const used = new Set(loops.filter(l => isWindowed(l.expr)).map(l => windowArg(l.expr)));
  const dead = CATALOG_LISTS.filter(s => !used.has(s));
  assert.deepEqual(dead, [], `CATALOG_LISTS-Einträge ohne gefenstertes x-for (umbenannt?): ${dead.join(', ')}`);
});

test('x-for direkt über $store.catalog ist gefenstert oder begründet', () => {
  const bad = loops
    .filter(l => /\$store\.catalog\./.test(l.expr) && !isWindowed(l.expr))
    .filter(l => !ALLOW[`${l.file}:${l.expr}`])
    .map(l => `${l.file}: x-for über ${l.expr}`);
  assert.deepEqual(bad, [], `Schleife über einen Buchkatalog ohne Fenster — listWindowed(…) oder Eintrag in ALLOW mit Begründung:\n${bad.join('\n')}`);
  const live = new Set(loops.map(l => `${l.file}:${l.expr}`));
  const stale = Object.keys(ALLOW).filter(k => !live.has(k));
  assert.deepEqual(stale, [], `ALLOW-Einträge ohne passende Schleife: ${stale.join(', ')}`);
});

test('jedes Fenster hat seinen «Weitere anzeigen»-Knopf', () => {
  const bad = [...new Set(loops.filter(l => isWindowed(l.expr)).map(l => l.file))]
    .filter(f => {
      const src = loops.find(l => l.file === f).src;
      return !src.includes('listWindowRest(') || !src.includes('x-list-more=');
    });
  assert.deepEqual(bad, [], `listWindowed ohne «Weitere anzeigen» (listWindowRest + x-list-more):\n${bad.join('\n')}`);
});

// Gate fuer den Lauf-Verlauf (DESIGN.md «Lauf-Verlauf», public/js/run-history.js):
// die Zeile einer Liste frueherer Laeufe (KI-Laeufe, Bewertungen, Export-Sets)
// entsteht ausschliesslich im Fragment run-history-row.html, ihr Datum
// ausschliesslich ueber formatRunDate aus run-history.js.
//
// Geprueft wird:
//   1. Kein Partial (und nicht index.html) baut eine `history-item`-Zeile von
//      Hand ausserhalb von run-history-row.html — Ausnahmen mit Begruendung in
//      ALLOW (andere Semantik als «Lauf aufklappen/oeffnen»).
//   2. Keine lokale `formatRunDate`-Implementierung in Browser-JS ausser
//      run-history.js.
//   3. Jede Einbettung von run-history-row legt den Adapter an:
//      `x-data="{ runRow: <karte>RunRow() }"` in derselben Datei.
//   4. Das Fragment traegt das Pflicht-Markup: offen-Zustand `history-item--open`,
//      Chevron, Loeschen-Symbol in der Zeile (`history-item-delete hover-reveal`).
//   5. Der Umweg ist zu: kein Loeschknopf im aufgeklappten Detail
//      (`btn-delete-history`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const rel = (p) => relative(REPO_ROOT, p);
const ROW = 'public/partials/run-history-row.html';
const CORE = 'public/js/run-history.js';

// Bewusste Ausnahmen: eigene Zeilen mit anderer Semantik.
const ALLOW = {
  'public/partials/page-history.html':
    'Prüf-Verlauf des Lektorats: Klick lädt die Prüfung in den Editor (Auswahl, `--active`), Erledigt-Schalter je Zeile — kein Aufklappen.',
  'public/partials/tagebuch-rueckblick-history-row.html':
    'Rückblick-Auswahlliste: feste Spalten (Zeitraum zuerst), Container-Query blendet das Modell aus, Auswahl (`--active`) zeigt den Rückblick im Hauptbereich.',
  'public/partials/page-revisions-row.html':
    'Abschnitts-Revisionen: Personen-Chip, Anheften, Wiederherstellen — kein KI-Lauf.',
  'public/partials/page-revisions.html':
    '«Weitere laden»-Zeile am Ende der Revisionsliste, keine Lauf-Zeile.',
};

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const partials = [
  ...walk(join(REPO_ROOT, 'public', 'partials'), '.html'),
  join(REPO_ROOT, 'public', 'index.html'),
];
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

test('history-item-Zeile nur im Fragment run-history-row', () => {
  const bad = [];
  for (const f of partials) {
    const r = rel(f);
    if (r === ROW || ALLOW[r]) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/class="history-item(?=[\s"])/g)) bad.push(`${r}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(bad, [], `Lauf-Zeile von Hand gebaut — <!-- @include run-history-row --> + runRowAdapter verwenden:\n  ${bad.join('\n  ')}`);
});

test('Allowlist ist aktuell (jede Ausnahme baut noch eine history-item-Zeile)', () => {
  for (const r of Object.keys(ALLOW)) {
    const src = readFileSync(join(REPO_ROOT, r), 'utf8');
    assert.match(src, /class="history-item(?=[\s"])/, `${r} steht auf der Allowlist, baut aber keine history-item-Zeile mehr`);
  }
});

test('keine lokale formatRunDate-Implementierung', () => {
  const bad = [];
  for (const f of walk(join(REPO_ROOT, 'public', 'js'), '.js')) {
    if (rel(f) === CORE) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:^\s*(?:async\s+)?formatRunDate\s*\([^)]*\)\s*\{|function\s+formatRunDate\b|formatRunDate\s*[:=]\s*(?:function|\())/gm)) {
      bad.push(`${rel(f)}:${lineOf(src, m.index)}`);
    }
  }
  assert.deepEqual(bad, [], `formatRunDate lokal implementiert — aus run-history.js importieren:\n  ${bad.join('\n  ')}`);
});

test('jede Einbettung von run-history-row legt den runRow-Adapter an', () => {
  const bad = [];
  for (const f of partials) {
    const src = readFileSync(f, 'utf8');
    const includes = [...src.matchAll(/<!--\s*@include\s+run-history-row\s*-->/g)].length;
    if (!includes) continue;
    if (!/x-data="\{\s*runRow:\s*\w+RunRow\(\)\s*\}"/.test(src)) bad.push(rel(f));
  }
  assert.deepEqual(bad, [], `run-history-row ohne x-data="{ runRow: …RunRow() }":\n  ${bad.join('\n  ')}`);
});

test('Fragment traegt offen-Zustand, Chevron und Loeschen in der Zeile', () => {
  const src = readFileSync(join(REPO_ROOT, ROW), 'utf8');
  assert.match(src, /'history-item--open':\s*runRow\.isOpen\(r\)/);
  assert.match(src, /class="history-chevron"/);
  assert.match(src, /class="history-item-delete hover-reveal"/);
  assert.match(src, /common\.deleteEntry/);
});

test('kein Loeschknopf im aufgeklappten Detail (btn-delete-history)', () => {
  const bad = [];
  const files = [...partials, ...walk(join(REPO_ROOT, 'public', 'js'), '.js'), ...walk(join(REPO_ROOT, 'public', 'css'), '.css')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (src.includes('btn-delete-history')) bad.push(rel(f));
  }
  assert.deepEqual(bad, [], `btn-delete-history — Löschen gehört als .history-item-delete in die Zeile:\n  ${bad.join('\n  ')}`);
});

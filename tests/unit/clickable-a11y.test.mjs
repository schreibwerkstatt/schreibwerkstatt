// Tripwire fuer public/CLAUDE.md «A11y: klickbare Nicht-Buttons»: ein `@click`
// auf einem nicht-interaktiven Element (div/span/li/td/tr/p/h*/img/section/
// article) ist mit der Maus erreichbar, mit der Tastatur nicht. Pflicht ist
// `.internal-link` (role=button + tabindex + Enter/Leertaste ueber die globale
// Delegation in public/js/app/boot/internal-links.js), ein echtes <button> oder
// eigenes `role` + `tabindex`. Was bewusst kein Tastaturziel ist (Delegation in
// gerendertes HTML, Backdrop, reine `.stop`-Schranken ohne Ausdruck), steht mit
// Begruendung in ALLOW.
//
// Zweite Regel: `.internal-link` nie direkt am <li> — role=button ersetzt die
// listitem-Rolle, der Screenreader verliert Liste und Position. Das Klickziel
// gehoert an ein inneres Element.
//
// Dritte Regel: `.internal-link` traegt kein Aussehen. Das Link-Aussehen ist
// `.text-link`; Zeilen und Kacheln zeigen Hover ueber ihren eigenen Hintergrund.
// Darum setzt keine `.internal-link`-Hover-Regel Unterstreichung oder Deckkraft,
// und ein <button> traegt die Klasse nicht (er ist ohnehin bedienbar).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS = join(REPO_ROOT, 'public', 'partials');

const FILES = [
  'public/index.html',
  ...readdirSync(PARTIALS).filter(f => f.endsWith('.html')).map(f => `public/partials/${f}`),
];

// [Datei, eindeutiger Ausschnitt des Tags, Begruendung]
const ALLOW = [
  ['public/index.html', 'class="boss-screen"',
    'Privacy-Vorhang (aria-hidden); Klick ist Maus-Abkuerzung, die Tastatur hebt ihn ueber das Chef-Kuerzel auf (editor/shortcuts.js)'],
  ['public/partials/editor-body-view.html', 'class="page-content-view"',
    'Delegation in gerendertes Seiten-HTML (Marker, Todos, Links) — Klickziele sind die Kinder, nicht der Container'],
  ['public/partials/editor-findings.html', 'x-html="$app.analysisOut"',
    'Delegation auf die Diskutieren-<button> im gerenderten Lektorat-Output'],
  ['public/partials/palette.html', 'class="palette-overlay"',
    'Backdrop der Command-Palette (Klick daneben schliesst); Tastatur schliesst per Esc'],
  ['public/partials/sidebar.html', 'class="history-chevron"',
    'Chevron im Kapitelkopf; Tastatur ueber den Kopf selbst (Enter/Leertaste) und die Baum-Tastatur (book/tree/keyboard.js)'],
  ['public/partials/snapshots-reader.html', 'class="snapshot-reader__backdrop"',
    'Backdrop des Fassungs-Readers; Tastatur schliesst per Esc bzw. Schliessen-Knopf'],
  ['public/partials/fehler-heatmap.html', 'class="heatmap-cell"',
    '`internal-link` kommt mit `row.cells[typ].cls` aus buildFehlerRows (book/fehler-heatmap.js), nur fuer Zellen mit Befunden'],
  ['public/partials/stil-heatmap.html', 'class="heatmap-cell"',
    '`internal-link` kommt mit `c.cells[m.key].cls` aus book/stil-heatmap.js, nur fuer klickbare Zellen'],
];

const TAG_RE = /<(div|span|li|td|tr|p|h[1-6]|img|section|article)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// `@click` / `x-on:click` mit Ausdruck; `.outside` ist kein Aktivieren.
const CLICK_RE = /(?:@click|x-on:click)((?:\.[\w-]+)*)="([^"]*)"/g;

function clickHandlers(attrs) {
  return [...attrs.matchAll(CLICK_RE)]
    .filter(m => !m[1].split('.').includes('outside') && m[2].trim() !== '');
}

function keyboardReachable(attrs) {
  if (/internal-link/.test(attrs)) return true;
  // Schreibflaeche (Editor) — Klick setzt den Cursor, kein Aktivieren.
  if (/(?:^|\s|:)contenteditable=/.test(attrs)) return true;
  // Listbox-Eintrag: Tastatur fuehrt das besitzende Eingabefeld (Pfeiltasten +
  // aria-selected), der Eintrag selbst ist bewusst kein Tab-Stopp.
  if (/(?:^|\s)role="option"/.test(attrs)) return true;
  return /(?:^|\s|:)role=/.test(attrs) && /(?:^|\s|:)tabindex=/.test(attrs);
}

export function findOffenders(files, read, allow = ALLOW) {
  const offenders = [];
  const used = new Set();
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(TAG_RE)) {
      const attrs = m[2];
      if (!clickHandlers(attrs).length || keyboardReachable(attrs)) continue;
      const hit = allow.findIndex(([f, snip]) => f === file && m[0].includes(snip));
      if (hit >= 0) { used.add(hit); continue; }
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line} <${m[1]}>`);
    }
  }
  return { offenders, used };
}

export function findListItemLinks(files, read) {
  const out = [];
  const re = /<li\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(re)) {
      if (!/internal-link/.test(m[1])) continue;
      out.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

export function findButtonLinks(files, read) {
  const out = [];
  const re = /<button\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(re)) {
      if (!/internal-link/.test(m[1])) continue;
      out.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

// Regel-Bloecke, deren Selektor `.internal-link` mit `:hover` kombiniert und die
// trotzdem Unterstreichung oder Deckkraft setzen.
export function findStyledHover(files, read) {
  const out = [];
  const re = /([^{}]*\.internal-link[^{}]*:hover[^{}]*)\{([^{}]*)\}/g;
  for (const file of files) {
    for (const m of read(file).matchAll(re)) {
      if (/text-decoration|opacity/.test(m[2])) out.push(`${file}: ${m[1].trim()}`);
    }
  }
  return out;
}

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith('.css') ? [relative(REPO_ROOT, p)] : [];
  });
}

const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

test('@click auf Nicht-Buttons ist tastatur-erreichbar (.internal-link, role+tabindex oder begruendet)', () => {
  const { offenders } = findOffenders(FILES, read);
  assert.deepEqual(offenders, [],
    `Klickbares Nicht-Button-Element ohne Tastaturzugang — .internal-link setzen, <button> nehmen oder in ALLOW begruenden:\n${offenders.join('\n')}`);
});

test('ALLOW enthaelt keine verwaisten Eintraege', () => {
  const { used } = findOffenders(FILES, read);
  const stale = ALLOW.filter((_, i) => !used.has(i)).map(([f, s]) => `${f} ${s}`);
  assert.deepEqual(stale, [], `Eintrag greift nicht mehr — entfernen:\n${stale.join('\n')}`);
});

test('.internal-link nie am <li> (Listen-Semantik bleibt)', () => {
  const hits = findListItemLinks(FILES, read);
  assert.deepEqual(hits, [], `.internal-link an ein inneres Element des <li> setzen:\n${hits.join('\n')}`);
});

test('.internal-link nie am <button> (Link-Aussehen ist .text-link)', () => {
  const hits = findButtonLinks(FILES, read);
  assert.deepEqual(hits, [], `<button> ist schon bedienbar — .internal-link entfernen, fuer Link-Aussehen .text-link:\n${hits.join('\n')}`);
});

test('.internal-link:hover setzt weder Unterstreichung noch Deckkraft', () => {
  const hits = findStyledHover(cssFiles(join(REPO_ROOT, 'public', 'css')), read);
  assert.deepEqual(hits, [], `Link-Aussehen gehoert an .text-link, Zeilen-Hover an den Hintergrund:\n${hits.join('\n')}`);
});

test('Selbsttest: Detektor schlaegt an und laesst Erlaubtes durch', () => {
  const fake = {
    'a.html': '<div class="row" @click="open()">x</div>',
    'b.html': '<div class="row internal-link" @click="open()">x</div>',
    'c.html': '<span role="button" tabindex="0" @click="open()"></span>',
    'd.html': '<span class="x" @click.stop @pointerdown.stop></span><div @click.outside="close()"></div>',
    'e.html': '<td :class="{ \'internal-link\': ok }" @click="go()"></td>',
    'f.html': '<li class="internal-link" @click="go()"></li><li><div class="internal-link"></div></li>',
  };
  const r = (f) => fake[f];
  const { offenders } = findOffenders(Object.keys(fake), r, []);
  assert.deepEqual(offenders, ['a.html:1 <div>']);
  assert.deepEqual(findListItemLinks(Object.keys(fake), r), ['f.html:1']);
  const btn = { 'g.html': '<button class="text-link">x</button>\n<button class="internal-link">y</button>' };
  assert.deepEqual(findButtonLinks(['g.html'], (f) => btn[f]), ['g.html:2']);
  const css = { 'h.css': '.row.internal-link:hover { background: red; }\n.internal-link:hover { opacity: 0.65; }' };
  assert.deepEqual(findStyledHover(['h.css'], (f) => css[f]), ['h.css: .internal-link:hover']);
});

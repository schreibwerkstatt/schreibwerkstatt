// Nachrichtenverlauf: die SSoT der Klassennamen ist public/js/messages/msg-html.js.
// Serverseitige CJS-Module, das LanguageTool-Mapping (hält sich frei von
// App-Bundle-Importen) und die Stylesheets führen bewusste KOPIEN. Dieser Test
// hält sie deckungsgleich — weicht eine ab, verliert genau dieser Ausgabeweg den
// Verlauf lautlos (flachgeklopft, als Fliesstext gesetzt, ungestylt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { MSG_THREAD_CLASS, MSG_THREAD_SEL, MSG_KIND_CLASS, msgNameSides } = await import('../../public/js/messages/msg-html.js');
const KIND_CLASSES = Object.values(MSG_KIND_CLASS);

test('html-walker: Klassenkopie deckungsgleich', () => {
  const src = read('lib/pdf-render/html-walker.js');
  assert.match(src, new RegExp(`const MSG_THREAD_CLASS = '${MSG_THREAD_CLASS}';`));
  for (const [k, c] of Object.entries(MSG_KIND_CLASS)) {
    assert.match(src, new RegExp(`${k}: '${c}'`), `walker: ${k} → ${c}`);
  }
});

test('Server-Cleaner: Verlauf ist ein struktureller div (nicht flachgeklopft)', async () => {
  const { flattenDivBlocks, ensureBlockIds } = await import('../../lib/html-clean.js');
  const html = `<div class="${MSG_THREAD_CLASS}"><p class="${MSG_KIND_CLASS.out}">x</p></div>`;
  assert.match(flattenDivBlocks(html), new RegExp(`<div class="${MSG_THREAD_CLASS}">`));
  assert.match(ensureBlockIds(html), /<div [^>]*data-bid=/);
});

test('Editor-Block-IDs spiegeln den Server-Selektor', () => {
  assert.match(read('public/js/editor/notebook/block-ids.js'), new RegExp(`div\\.${MSG_THREAD_CLASS}`));
});

test('LanguageTool prüft den Verlauf, jede Zeile als eigener Absatz', async () => {
  const { parseHTML } = await import('linkedom');
  const { buildOffsetTable } = await import('../../public/js/cards/editor-spellcheck/mapping.js');
  const { document } = parseHTML(`<div id="r"><p>Davor.</p><div class="${MSG_THREAD_CLASS}"><p class="msg-in">bist du da</p><p class="msg-out">gleich</p></div></div>`);
  assert.equal(buildOffsetTable(document.getElementById('r')).text, 'Davor.\n\nbist du da\n\ngleich');
});

test('Text-Pfade (Prompt-Marken, TXT, WordPress) kennen die Klassen', async () => {
  const { markMsgThreads, htmlToPlainTextWithMsgRanges } = await import('../../lib/html-text.js');
  assert.match(markMsgThreads(`<div class="${MSG_THREAD_CLASS}"><p>x</p></div>`), /^<p>\[/);
  // Dialog-Erkennung: Nachrichten sind Rede, Absender und Zeit nicht.
  const lines = Object.values(MSG_KIND_CLASS).map(c => `<p class="${c}">${c}</p>`).join('');
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(`<div class="${MSG_THREAD_CLASS}">${lines}</div>`);
  assert.deepEqual(msgRanges.map(([a, b]) => text.slice(a, b)), [MSG_KIND_CLASS.in, MSG_KIND_CLASS.out]);
  const txt = read('lib/export-builders/txt.js');
  assert.match(txt, new RegExp(`\\\\b${MSG_THREAD_CLASS}\\\\b`));
  for (const c of ['msg-name', 'msg-meta', 'msg-out']) assert.ok(KIND_CLASSES.includes(c) && txt.includes(`'${c}'`), `txt: ${c}`);
  assert.match(read('lib/wp-html.js'), new RegExp(`const MSG_THREAD_CLASS = '${MSG_THREAD_CLASS}';`));
});

test('Stylesheets (App, EPUB, HTML-Export) stylen alle Zeilenarten', () => {
  const sheets = {
    'public/css/components/manuscript-content.css': read('public/css/components/manuscript-content.css'),
    'lib/export-builders/epub/css.js': read('lib/export-builders/epub/css.js'),
    'lib/export-builders/html.js': read('lib/export-builders/html.js'),
  };
  for (const [file, css] of Object.entries(sheets)) {
    assert.ok(css.includes(`.${MSG_THREAD_CLASS}`), `${file}: .${MSG_THREAD_CLASS}`);
    for (const c of ['msg-out', 'msg-name', 'msg-meta']) {
      assert.ok(css.includes(`.${c}`), `${file}: .${c}`);
    }
  }
});

test('Paste-Allowlist lässt Verlauf und Zeilenarten durch', () => {
  const src = read('public/js/utils/html.js');
  assert.match(src, /MSG_THREAD_CLASS/);
  assert.match(src, /MSG_KIND_CLASS/);
});

test('Absender-Seite: Server-Kopie rechnet wie die SSoT', async () => {
  const { msgNameSides: serverSides } = await import('../../lib/msg-lines.js');
  const cases = [
    ['name', 'in'], ['name', 'out'], ['name', 'meta', 'out'], ['name', 'name', 'out'],
    ['name'], ['in', 'name', 'meta', 'meta', 'out', 'name', 'in'], [],
  ];
  for (const kinds of cases) assert.deepEqual(serverSides(kinds), msgNameSides(kinds), kinds.join(','));
  assert.deepEqual(msgNameSides(['name', 'meta', 'out', 'name']), ['out', null, null, 'in']);
});

test('Export-Klasse msg-name-out: Erzeuger und beide Export-Stylesheets', () => {
  assert.match(read('lib/html-text.js'), /msg-name-out/);
  for (const f of ['lib/export-builders/epub/css.js', 'lib/export-builders/html.js']) {
    assert.match(read(f), /\.msg-thread p\.msg-name-out \{/, f);
  }
});

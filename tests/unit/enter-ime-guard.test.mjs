// Tripwire fuer public/CLAUDE.md «Enter in Textfeldern»: Enter als Absenden/
// Speichern an einem <input>/<textarea> laeuft nur ueber die Magic `$enter`
// (public/js/utils/keys.js#handleEnterKey, registriert in app/register-cards.js).
// Sie ignoriert Enter waehrend einer IME-Komposition (`isComposing`, Safari:
// `keyCode 229`) — dort bestaetigt Enter die Zeichenwahl. Ein rohes
// `@keydown.enter="save()"` sendet mitten in der Komposition, ein
// `@keydown.enter.prevent` verschluckt zusaetzlich die Uebernahme.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleEnterKey } from '../../public/js/utils/keys.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS = join(REPO_ROOT, 'public', 'partials');
const FILES = [
  'public/index.html',
  ...readdirSync(PARTIALS).filter(f => f.endsWith('.html')).map(f => `public/partials/${f}`),
];

// [Datei, Begruendung] — ganze Datei ausgenommen.
const ALLOW_FILES = [
  ['public/partials/book-settings-series.html', 'wird parallel umgebaut'],
  ['public/partials/book-settings-share.html', 'wird parallel umgebaut'],
];

const FIELD_RE = /<(input|textarea)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ENTER_RE = /(?:@|x-on:)keydown\.enter((?:\.[\w-]+)*)="([^"]*)"/g;

export function findOffenders(files, read) {
  const out = [];
  for (const file of files) {
    if (ALLOW_FILES.some(([f]) => f === file)) continue;
    const src = read(file);
    for (const m of src.matchAll(FIELD_RE)) {
      for (const e of m[2].matchAll(ENTER_RE)) {
        const mods = e[1].split('.').filter(Boolean);
        const line = src.slice(0, m.index).split('\n').length;
        if (!/^\s*\$enter\(\$event,/.test(e[2])) out.push(`${file}:${line} ohne $enter`);
        else if (mods.includes('prevent')) out.push(`${file}:${line} .prevent neben $enter`);
      }
    }
  }
  return out;
}

const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

test('Enter an Textfeldern nur ueber $enter (IME-Guard)', () => {
  const offenders = findOffenders(FILES, read);
  assert.deepEqual(offenders, [],
    `@keydown.enter an <input>/<textarea> → @keydown.enter="$enter($event, () => …)" (ohne .prevent):\n${offenders.join('\n')}`);
});

test('kein handgeschriebener IME-Guard in Templates', () => {
  const hits = [];
  for (const file of FILES) {
    if (ALLOW_FILES.some(([f]) => f === file)) continue;
    read(file).split('\n').forEach((l, i) => {
      if (/\$event\.isComposing|\$event\.keyCode\s*!==?\s*229/.test(l)) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `IME-Guard steckt in $enter — nicht inline nachbauen:\n${hits.join('\n')}`);
});

test('$enter ist als Magic registriert und nutzt den geteilten Handler', () => {
  const src = readFileSync(join(REPO_ROOT, 'public/js/app/register-cards.js'), 'utf8');
  assert.match(src, /Alpine\.magic\('enter', \(\) => handleEnterKey\)/);
});

test('handleEnterKey: Komposition, Modifier, preventDefault', () => {
  const ev = (o = {}) => {
    const e = { key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, prevented: false, ...o };
    e.preventDefault = () => { e.prevented = true; };
    return e;
  };
  let n = 0;
  const fire = () => { n++; };
  let e = ev({ isComposing: true }); handleEnterKey(e, fire); assert.equal(n, 0); assert.equal(e.prevented, false);
  e = ev({ keyCode: 229 }); handleEnterKey(e, fire); assert.equal(n, 0); assert.equal(e.prevented, false);
  e = ev(); handleEnterKey(e, fire); assert.equal(n, 1); assert.equal(e.prevented, true);
  e = ev({ shiftKey: true }); handleEnterKey(e, fire); assert.equal(n, 2, 'einzeilig: Umschalt+Enter loest aus');
  e = ev({ shiftKey: true }); handleEnterKey(e, fire, { multiline: true }); assert.equal(n, 2); assert.equal(e.prevented, false);
  e = ev({ metaKey: true }); handleEnterKey(e, fire, { multiline: true }); assert.equal(n, 2);
  e = ev(); handleEnterKey(e, fire, { multiline: true }); assert.equal(n, 3);
});

test('Selbsttest: Detektor schlaegt an', () => {
  const fake = {
    'a.html': '<input @keydown.enter="save()">',
    'b.html': '<input @keydown.enter.prevent="$enter($event, () => save())">',
    'c.html': '<textarea @keydown.enter="$enter($event, () => send(), { multiline: true })"></textarea>',
    'd.html': '<div @keydown.enter.prevent="open()"></div>',
  };
  assert.deepEqual(findOffenders(Object.keys(fake), f => fake[f]),
    ['a.html:1 ohne $enter', 'b.html:1 .prevent neben $enter']);
});

// Zeitfenster für erzählte Zeit (lib/time-key.js) — pure Rechnung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { timeKeyOf, keysOverlap } = require('../../lib/time-key.js');

test('undatiert und Datum ohne Jahr ergeben kein Fenster', () => {
  assert.equal(timeKeyOf(''), null);
  assert.equal(timeKeyOf(null), null);
  assert.equal(timeKeyOf('vor der Reise'), null);
  assert.equal(timeKeyOf('Mai'), null);
  assert.equal(timeKeyOf('12.03.'), null);
});

test('Genauigkeit folgt der Angabe', () => {
  const p = s => timeKeyOf(s).precision;
  assert.equal(p('12.03.1987'), 'day');
  assert.equal(p('Anfang März 1987'), 'part');
  assert.equal(p('März 1987'), 'month');
  assert.equal(p('Sommer 1987'), 'season');
  assert.equal(p('Ende 1987'), 'part');
  assert.equal(p('1987'), 'year');
  assert.equal(p('1987–1989'), 'range');
  assert.equal(p('Tag 3'), 'day');
  assert.equal(p('Tag 3–5'), 'range');
});

test('Fenster sind geschachtelt: Tag ⊂ Monat ⊂ Jahreszeit ⊂ Jahr', () => {
  const tag = timeKeyOf('15. Juli 1987');
  const monat = timeKeyOf('Juli 1987');
  const sommer = timeKeyOf('Sommer 1987');
  const jahr = timeKeyOf('1987');
  const inside = (a, b) => a.from >= b.from && a.to <= b.to;
  assert.ok(inside(tag, monat) && inside(monat, sommer) && inside(sommer, jahr));
  assert.ok(!keysOverlap(timeKeyOf('Juli 1987'), timeKeyOf('Mai 1987')));
});

test('Winter läuft über den Jahreswechsel; Winter 1944/45 ist ein Winter', () => {
  const w = timeKeyOf('Winter 1944/45');
  assert.equal(w.precision, 'season');
  assert.deepEqual([w.yearFrom, w.yearTo], [1944, 1945]);
  assert.ok(keysOverlap(w, timeKeyOf('Januar 1945')));
  assert.ok(!keysOverlap(w, timeKeyOf('Juli 1945')));
});

test('v. Chr. ordnet vor n. Chr.', () => {
  assert.ok(timeKeyOf('500 v. Chr.').to < timeKeyOf('312').from);
  assert.equal(timeKeyOf('500 v. Chr.').yearFrom, -500);
});

test('unsicher verbreitert das Fenster, verschiebt es nicht', () => {
  const k = timeKeyOf('um 1900');
  assert.deepEqual([k.yearFrom, k.yearTo, k.unsicher], [1898, 1902, true]);
  const m = timeKeyOf('ca. März 1987');
  assert.ok(keysOverlap(m, timeKeyOf('Februar 1987')) && keysOverlap(m, timeKeyOf('April 1987')));
});

test('Kalenderzeit und Story-Tage überlappen nie', () => {
  assert.equal(keysOverlap(timeKeyOf('Tag 3'), timeKeyOf('3')), false);
  assert.equal(timeKeyOf('Tag 3').mode, 'tag');
});

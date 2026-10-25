// Anzeige des Zeitfensters (public/js/book/plot/zeit-format.js) gegen echte
// Server-Fenster (lib/time-key.js) — hält die Ordinalskala beider Seiten synchron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { formatZeitKey } from '../../public/js/book/plot/zeit-format.js';

const require = createRequire(import.meta.url);
const { timeKeyOf } = require('../../lib/time-key.js');

const T = {
  'events.span': '{start} – {ende}', 'events.circa': 'ca. {date}', 'events.storyDay': 'Tag {n}',
  'plot.zeitKey.bce': '{jahr} v. Chr.',
};
const t = (k, p = {}) => (T[k] || k).replace(/\{(\w+)\}/g, (_, n) => p[n]);
const f = s => formatZeitKey(timeKeyOf(s), t);

test('jede Genauigkeit wird verstanden angezeigt', () => {
  assert.equal(f('12. März 1987'), '12.03.1987');
  assert.equal(f('März 1987'), '03.1987');
  assert.equal(f('Sommer 1987'), '06.1987 – 08.1987');
  assert.equal(f('Spätsommer 1987'), '08.1987');
  assert.equal(f('Winter 1944/45'), '12.1944 – 02.1945');
  assert.equal(f('Anfang März 1987'), '01.03.1987 – 10.03.1987');
  assert.equal(f('Ende 1987'), '09.1987 – 12.1987');
  assert.equal(f('1987'), '1987');
  assert.equal(f('1980er'), '1980 – 1989');
  assert.equal(f('12.–15. März 1987'), '12.03.1987 – 15.03.1987');
  assert.equal(f('um 1900'), 'ca. 1898 – 1902');
  assert.equal(f('500 v. Chr.'), '500 v. Chr.');
  assert.equal(f('Tag 3'), 'Tag 3');
  assert.equal(f('Tag 3–5'), 'Tag 3 – Tag 5');
});

test('kein Fenster → null', () => {
  assert.equal(formatZeitKey(null, t), null);
  assert.equal(f('vor der Reise'), null);
});

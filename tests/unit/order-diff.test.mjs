import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeOrderChange } = require('../../lib/order-diff.js');

const P = (id) => ({ type: 'page', id });
const C = (id, children = []) => ({ type: 'chapter', id, children });

test('describeOrderChange: Zählung und erster Baum', () => {
  assert.equal(describeOrderChange(null, [C(1, [P(10), P(11)]), P(12)]),
    '1 Kapitel, 3 Abschnitte; erster gespeicherter Baum');
});

test('describeOrderChange: unverändert', () => {
  const t = [C(1, [P(10), P(11)])];
  assert.equal(describeOrderChange(t, t), '1 Kapitel, 2 Abschnitte; unverändert');
});

test('describeOrderChange: Umsortieren innerhalb einer Ebene', () => {
  assert.equal(describeOrderChange([C(1, [P(10), P(11)])], [C(1, [P(11), P(10)])]),
    '1 Kapitel, 2 Abschnitte; umsortiert in: Kapitel 1');
});

test('describeOrderChange: Umhängen ohne Folgeänderung zählt nicht als Umsortieren', () => {
  const before = [C(1, [P(10), P(11)]), C(2, [P(20)])];
  const after = [C(1, [P(11)]), C(2, [P(20), P(10)])];
  assert.equal(describeOrderChange(before, after),
    '2 Kapitel, 3 Abschnitte; umgehängt: Abschnitt 10 (Kapitel 1→Kapitel 2)');
});

test('describeOrderChange: Kapitel nach oben, neue und fehlende Knoten', () => {
  const before = [C(1, [C(5, [P(50)])]), P(9)];
  const after = [C(1), C(5, [P(50)]), P(7)];
  assert.equal(describeOrderChange(before, after),
    '2 Kapitel, 2 Abschnitte; umgehängt: Kapitel 5 (Kapitel 1→oben), Abschnitt 7 (neu → oben), Abschnitt 9 (fehlt jetzt)');
});

test('describeOrderChange: lange Liste gedeckelt', () => {
  const before = [C(1, Array.from({ length: 12 }, (_, i) => P(100 + i))), C(2)];
  const after = [C(1), C(2, Array.from({ length: 12 }, (_, i) => P(100 + i)))];
  assert.match(describeOrderChange(before, after), / …\+2$/);
});

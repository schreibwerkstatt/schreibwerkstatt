// Familiengraph: Kanten-Normalisierung, Generationen, Raster-Packung.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  familyEdges, familyLevels, familyComponents, packFamilies,
} from '../../public/js/graph/family-layout.js';

const e = (from, typ, to) => ({ from, to, typ });

describe('familyEdges', () => {
  test('elternteil wird zu kind von Eltern zu Kind gedreht, Doppel aus beiden Perspektiven fallen weg', () => {
    const out = familyEdges([
      e('stefan', 'elternteil', 'gisela'),
      e('gisela', 'kind', 'stefan'),
      e('stefan', 'kind', 'manuel'),
    ], { arrows: 'from' });
    assert.deepStrictEqual(out.map(x => [x.from, x.typ, x.to]), [
      ['gisela', 'kind', 'stefan'],
      ['stefan', 'kind', 'manuel'],
    ]);
    assert.strictEqual(out[0].arrows, 'from');
  });

  test('Ehepartner nur mit Blutsverwandtschaft im Baum; Geschwister ungerichtet dedupliziert', () => {
    const out = familyEdges([
      e('a', 'geschwister', 'b'), e('b', 'geschwister', 'a'),
      e('a', 'ehepartner', 'x'),
      e('p', 'ehepartner', 'q'),
      e('a', 'freund', 'b'),
    ]);
    assert.deepStrictEqual(out.map(x => x.typ), ['geschwister', 'ehepartner']);
  });
});

describe('familyLevels', () => {
  test('Eltern oben, Kinder darunter, Partner und Geschwister auf derselben Ebene', () => {
    const edges = familyEdges([
      e('stefan', 'elternteil', 'gisela'),
      e('stefan', 'kind', 'manuel'),
      e('renate', 'kind', 'manuel'),
      e('stefan', 'ehepartner', 'renate'),
      e('manuel', 'geschwister', 'simon'),
    ]);
    const ids = ['gisela', 'stefan', 'renate', 'manuel', 'simon'];
    const lv = familyLevels(ids, edges);
    assert.deepStrictEqual(ids.map(id => lv.get(id)), [0, 1, 1, 2, 2]);
  });

  test('eingeheirateter Elternteil ohne Eltern rückt an sein Kind heran', () => {
    const edges = familyEdges([
      e('oma', 'kind', 'vater'),
      e('vater', 'kind', 'kind1'),
      e('mutter', 'kind', 'kind1'),
    ]);
    const lv = familyLevels(['oma', 'vater', 'mutter', 'kind1'], edges);
    assert.strictEqual(lv.get('mutter'), lv.get('vater'));
  });

  test('jede Familie beginnt bei 0; Zyklus in Daten hängt nicht', () => {
    const edges = familyEdges([e('a', 'kind', 'b'), e('b', 'kind', 'a'), e('x', 'kind', 'y')]);
    const lv = familyLevels(['a', 'b', 'x', 'y'], edges);
    assert.strictEqual(lv.get('x'), 0);
    assert.strictEqual(Math.min(lv.get('a'), lv.get('b')), 0);
  });
});

describe('packFamilies', () => {
  test('viele kleine Familien landen im Raster statt in einer Reihe', () => {
    const positions = {};
    const edges = [];
    // 12 Familien à Eltern + Kind, wie vis sie nebeneinander legt.
    for (let i = 0; i < 12; i++) {
      positions[`p${i}`] = { x: i * 400, y: 0 };
      positions[`c${i}`] = { x: i * 400, y: 120 };
      edges.push(e(`p${i}`, 'kind', `c${i}`));
    }
    const comp = familyComponents(Object.keys(positions), edges);
    const out = packFamilies(positions, comp, { aspect: 1.6 });
    const xs = Object.values(out).map(p => p.x), ys = Object.values(out).map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    assert.ok(w / h < 4, `Seitenverhältnis ${w}/${h}`);
    // Innerhalb einer Familie bleibt die relative Lage erhalten.
    assert.strictEqual(out.c3.y - out.p3.y, 120);
    assert.strictEqual(out.c3.x - out.p3.x, 0);
  });
});

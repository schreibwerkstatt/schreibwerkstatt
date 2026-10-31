// Soziogramm-Layout: Band-Höhe, Band-Beschriftung, Machtmass.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  computeSoziogrammLayout, powerScores, schichtOf, BAND_HALF,
} from '../../public/js/graph/soziogramm-layout.js';

const fig = (id, sozialschicht, beziehungen = []) => ({ id, name: id, sozialschicht, beziehungen });

describe('computeSoziogrammLayout', () => {
  test('volle Schicht: Treppe bleibt im eigenen Band, Nachbarband rückt ab', () => {
    const figuren = [
      ...Array.from({ length: 30 }, (_, i) => fig('m' + i, 'mittelschicht')),
      fig('a', 'arbeiterschicht'),
    ];
    const { posById, bands } = computeSoziogrammLayout(figuren);
    const mittel = bands.find(b => b.schicht === 'mittelschicht');
    const arbeit = bands.find(b => b.schicht === 'arbeiterschicht');
    const ys = figuren.slice(0, 30).map(f => posById.get(f.id).y);
    assert.ok(Math.max(...ys) < mittel.y + mittel.half);
    assert.ok(Math.min(...ys) > mittel.y - mittel.half);
    assert.ok(arbeit.y - arbeit.half >= mittel.y + mittel.half, 'Bänder überlappen');
  });

  test('wenige Figuren: Standard-Raster wie bisher (190 je Ebene)', () => {
    const { bands } = computeSoziogrammLayout([fig('e', 'wirtschaftselite'), fig('m', 'mittelschicht')]);
    assert.deepStrictEqual(bands.map(b => [b.schicht, b.y, b.half]),
      [['wirtschaftselite', 0, BAND_HALF], ['mittelschicht', 380, BAND_HALF]]);
  });

  test('«andere» teilt die Ebene mit der Mittelschicht — die echte Schicht trägt das Band', () => {
    const { bands } = computeSoziogrammLayout([fig('x', 'andere'), fig('y', null), fig('m', 'mittelschicht')]);
    assert.deepStrictEqual(bands.map(b => b.schicht), ['mittelschicht']);
  });

  test('unbekannter Schicht-Wert zählt als «andere»', () => {
    assert.strictEqual(schichtOf(fig('x', 'oberschicht')), 'andere');
    assert.strictEqual(schichtOf(fig('x', 'prekariat')), 'prekariat');
  });
});

describe('powerScores', () => {
  test('nur einseitig erfasst: beide Figuren werden eingeordnet', () => {
    const p = powerScores([fig('a', 'mittelschicht', [{ figur_id: 'b', typ: 'feind', machtverhaltnis: 2 }]), fig('b', 'mittelschicht')]);
    assert.deepStrictEqual([p.get('a'), p.get('b')], [-2, 2]);
  });

  test('beidseitig erfasst (auch als Gegenpaar) zählt einmal', () => {
    const p = powerScores([
      fig('azubi', 'mittelschicht', [{ figur_id: 'chef', typ: 'vorgesetzter', machtverhaltnis: 1 }]),
      fig('chef', 'mittelschicht', [{ figur_id: 'azubi', typ: 'untergebener', machtverhaltnis: -1 }]),
    ]);
    assert.deepStrictEqual([p.get('azubi'), p.get('chef')], [-1, 1]);
  });
});

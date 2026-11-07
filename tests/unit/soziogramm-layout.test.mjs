// Soziogramm-Layout: Bänder, Zeilen nach Macht, Nähe-Federn, Kapitel-Inseln,
// Begegnungen, Hüllen. Der Roman-Fixture ist die anonymisierte Struktur eines
// echten Buchs (5 Porträt-Kapitel, 137 Figuren) — an ihm hängen die Aussagen,
// für die das Layout gebaut ist.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import {
  computeSoziogrammLayout, powerScores, schichtOf, pairNaehe, begegnungenOf,
  BAND_HALF, LEVEL_Y_GAP, NODE_W, NAEHE_LEN,
} from '../../public/js/graph/soziogramm-layout.js';
import { relaxX } from '../../public/js/graph/soziogramm-force.js';
import { convexHull, paddedHull } from '../../public/js/graph/soziogramm-hulls.js';
import { naeheOf, NAEHE_DEFAULT_BY_TYP, RELATION_TYPES } from '../../public/js/book/beziehung-typen.js';

const ROMAN = JSON.parse(fs.readFileSync(new URL('../fixtures/soziogramm-roman.json', import.meta.url), 'utf8'));
const fig = (id, sozialschicht, beziehungen = [], kapitel = []) => ({ id, name: id, sozialschicht, beziehungen, kapitel });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const overlaps = (posById) => {
  const ps = [...posById.values()];
  let n = 0;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      if (Math.abs(ps[i].x - ps[j].x) < NODE_W - 5 && Math.abs(ps[i].y - ps[j].y) < 56) n++;
    }
  }
  return n;
};

describe('schichtOf / Bänder', () => {
  test('unbekannter Schicht-Wert zählt als «andere»', () => {
    assert.strictEqual(schichtOf(fig('x', 'oberschicht')), 'andere');
    assert.strictEqual(schichtOf(fig('x', 'prekariat')), 'prekariat');
  });

  test('«andere» hat ein eigenes Band direkt unter der untersten belegten Schicht', () => {
    const { bands } = computeSoziogrammLayout([fig('x', 'andere'), fig('y', null), fig('m', 'mittelschicht')]);
    assert.deepStrictEqual(bands.map(b => [b.schicht, b.y]),
      [['mittelschicht', 2 * LEVEL_Y_GAP], ['andere', 3 * LEVEL_Y_GAP]]);
  });

  test('leere echte Schicht behält ihren Platz', () => {
    const { bands } = computeSoziogrammLayout([fig('e', 'wirtschaftselite'), fig('m', 'mittelschicht')]);
    assert.deepStrictEqual(bands.map(b => [b.schicht, b.y, b.half]),
      [['wirtschaftselite', 0, BAND_HALF], ['mittelschicht', 2 * LEVEL_Y_GAP, BAND_HALF]]);
  });

  test('volle Schicht bleibt im eigenen Band (Zeilen statt Treppe)', () => {
    const figuren = Array.from({ length: 30 }, (_, i) => fig('m' + i, 'mittelschicht'));
    const { posById, bands } = computeSoziogrammLayout(figuren);
    const band = bands[0];
    for (const p of posById.values()) {
      assert.ok(Math.abs(p.y - band.y) < band.half, `y=${p.y} ausserhalb des Bands`);
    }
    assert.strictEqual(overlaps(posById), 0);
  });

  test('Mächtige stehen in der oberen Zeile ihrer Gruppe', () => {
    const figuren = [
      fig('chef', 'mittelschicht'),
      ...Array.from({ length: 11 }, (_, i) => fig('m' + i, 'mittelschicht', [{ figur_id: 'chef', typ: 'vorgesetzter', machtverhaltnis: 2 }])),
    ];
    const { posById } = computeSoziogrammLayout(figuren);
    const yChef = posById.get('chef').y;
    assert.ok(figuren.slice(1).every(f => posById.get(f.id).y >= yChef));
    assert.ok(figuren.slice(1).some(f => posById.get(f.id).y > yChef), 'mehrere Zeilen erwartet');
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

describe('Nähe', () => {
  test('jeder Beziehungstyp hat einen Standard', () => {
    assert.deepStrictEqual(RELATION_TYPES.filter(t => !(t in NAEHE_DEFAULT_BY_TYP)), []);
  });

  test('eingeschätzter Wert schlägt den Typ-Standard, Rohwerte werden geklemmt', () => {
    assert.deepStrictEqual(naeheOf({ typ: 'ehepartner', naehe: -1 }), { wert: -1, geschaetzt: true });
    assert.deepStrictEqual(naeheOf({ typ: 'ehepartner' }), { wert: 1, geschaetzt: false });
    assert.deepStrictEqual(naeheOf({ typ: 'freund', naehe: '7' }), { wert: 2, geschaetzt: true });
    assert.deepStrictEqual(naeheOf({ typ: 'vater' }), { wert: 1, geschaetzt: false }, 'Synonym über normalizeRelationTyp');
  });

  test('Paar zählt einmal, auch beidseitig erfasst', () => {
    const m = pairNaehe([
      fig('a', 'mittelschicht', [{ figur_id: 'b', typ: 'freund', naehe: 2 }]),
      fig('b', 'mittelschicht', [{ figur_id: 'a', typ: 'freund', naehe: 0 }]),
    ]);
    assert.deepStrictEqual([...m.values()], [{ a: 'a', b: 'b', naehe: 1 }]);
  });

  test('innige Paare liegen enger als verfeindete', () => {
    // Drei Paare im selben Band, sonst identisch.
    const figuren = [
      fig('a1', 'mittelschicht', [{ figur_id: 'a2', typ: 'freund', naehe: 2 }]), fig('a2', 'mittelschicht'),
      fig('b1', 'mittelschicht', [{ figur_id: 'b2', typ: 'freund', naehe: -2 }]), fig('b2', 'mittelschicht'),
    ];
    const { posById } = computeSoziogrammLayout(figuren);
    const d = (a, b) => Math.hypot(posById.get(a).x - posById.get(b).x, posById.get(a).y - posById.get(b).y);
    assert.ok(d('a1', 'a2') < d('b1', 'b2'), `nah ${d('a1', 'a2')} vs fern ${d('b1', 'b2')}`);
    assert.ok(d('b1', 'b2') > NAEHE_LEN[0], 'feindselig weiter als neutral');
  });
});

describe('relaxX', () => {
  test('deterministisch und ohne Überdeckung in einer Zeile', () => {
    const mk = () => Array.from({ length: 12 }, () => ({ x: 0, y: 0, anchor: 0, anchorK: 0.02 }));
    const a = relaxX(mk(), []).map(n => n.x);
    const b = relaxX(mk(), []).map(n => n.x);
    assert.deepStrictEqual(a, b);
    const xs = [...a].sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 174, `Abstand ${xs[i] - xs[i - 1]}`);
  });

  test('Y bleibt fest', () => {
    const nodes = [{ x: 0, y: 0, anchor: 0, anchorK: 0 }, { x: 10, y: 300, anchor: 0, anchorK: 0 }];
    relaxX(nodes, [{ a: 0, b: 1, len: 100, k: 0.05 }]);
    assert.deepStrictEqual(nodes.map(n => n.y), [0, 300]);
  });
});

describe('Hüllen', () => {
  test('konvexe Hülle lässt innere Punkte weg', () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
    assert.strictEqual(h.length, 4);
    assert.ok(!h.some(p => p.x === 5 && p.y === 5));
  });

  test('gepolsterte Hülle umschliesst jeden Knoten mit Abstand', () => {
    const pts = [{ x: 0, y: 0 }, { x: 200, y: 50 }];
    const h = paddedHull(pts, 30, { padX: 80 });
    assert.ok(Math.min(...h.map(p => p.x)) <= -79 && Math.max(...h.map(p => p.x)) >= 279);
    assert.ok(Math.min(...h.map(p => p.y)) <= -29 && Math.max(...h.map(p => p.y)) >= 79);
  });
});

describe('Roman-Fixture (5 Porträt-Kapitel)', () => {
  const opts = { kapitelOrder: ROMAN.kapitelOrder };

  test('Kapitel werden zu Inseln in Buchreihenfolge, Brücken liegen dazwischen', () => {
    const r = computeSoziogrammLayout(ROMAN.figuren, opts);
    assert.strictEqual(r.inseln, true);
    assert.strictEqual(r.islands.length, 5);
    const med = r.islands.map(isl => median(isl.members.map(id => r.posById.get(id).x)));
    for (let i = 1; i < med.length; i++) assert.ok(med[i] > med[i - 1] + 400, `Insel ${i} nicht rechts von ${i - 1}: ${med}`);
    assert.ok(r.bridges.size >= 10, 'Figuren aus mehreren Kapiteln');
    // Eine Brücke liegt zwischen ihrer äussersten Insel links und rechts.
    for (const [id, chs] of r.bridges) {
      const ixs = chs.map(c => ROMAN.kapitelOrder.indexOf(c));
      const x = r.posById.get(id).x;
      assert.ok(x >= med[Math.min(...ixs)] - 700 && x <= med[Math.max(...ixs)] + 700, `Brücke ${id} bei ${x}`);
    }
  });

  test('keine Überdeckung, und schnell genug für den Render-Pfad', () => {
    const t0 = performance.now();
    const r = computeSoziogrammLayout(ROMAN.figuren, opts);
    const ms = performance.now() - t0;
    assert.strictEqual(overlaps(r.posById), 0);
    assert.ok(ms < 500, `${Math.round(ms)} ms`);
  });

  test('Nähe ordnet die Abstände: innig < zugewandt < neutral', () => {
    const r = computeSoziogrammLayout(ROMAN.figuren, opts);
    const by = { 2: [], 1: [], 0: [], [-1]: [], [-2]: [] };
    for (const f of ROMAN.figuren) {
      for (const bz of f.beziehungen) {
        const a = r.posById.get(f.id), b = r.posById.get(bz.figur_id);
        if (b && bz.naehe != null) by[bz.naehe].push(Math.abs(a.x - b.x));
      }
    }
    assert.ok(median(by[2]) < median(by[0]), `innig ${median(by[2])} vs neutral ${median(by[0])}`);
    assert.ok(median(by[1]) < median(by[0]), `zugewandt ${median(by[1])} vs neutral ${median(by[0])}`);
  });

  test('Inseln aus: keine Hüllen, keine Brücken', () => {
    const r = computeSoziogrammLayout(ROMAN.figuren, { ...opts, inseln: false });
    assert.deepStrictEqual([r.inseln, r.islands.length, r.bridges.size], [false, 0, 0]);
  });

  test('Begegnungen: nur Paare ohne Beziehung, ab zwei gemeinsamen Szenen', () => {
    const rel = new Set(pairNaehe(ROMAN.figuren).keys());
    const meets = begegnungenOf(ROMAN.figuren, ROMAN.szenen, rel);
    assert.ok(meets.length > 0);
    for (const m of meets) {
      assert.ok(m.n >= 2);
      assert.ok(!rel.has(m.a + '|' + m.b));
    }
    const r = computeSoziogrammLayout(ROMAN.figuren, { ...opts, szenen: ROMAN.szenen, begegnungen: true });
    assert.strictEqual(r.begegnungen.length, meets.length);
    assert.strictEqual(computeSoziogrammLayout(ROMAN.figuren, { ...opts, szenen: ROMAN.szenen }).begegnungen.length, 0,
      'Schalter aus: keine Begegnungen');
  });

  test('durchgehende Figuren (fortlaufender Roman): keine Inseln', () => {
    const kap = ['k1', 'k2', 'k3', 'k4'];
    const figuren = Array.from({ length: 10 }, (_, i) => fig('f' + i, 'mittelschicht', [],
      kap.map(c => ({ chapter_id: c, haeufigkeit: 2 }))));
    assert.strictEqual(computeSoziogrammLayout(figuren, { kapitelOrder: kap }).inseln, false);
  });
});

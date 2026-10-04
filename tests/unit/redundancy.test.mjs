import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepare, scanBlock, finalizePairs, findRedundantPairs, findFigureDuplicates } = require('../../lib/redundancy.js');

// Kleiner Helfer: Chunk mit langem Text (über MIN_CHARS) + Vektor.
function chunk(entity_id, chunk_ix, vector, extra = '') {
  return { entity_id, chunk_ix, text: 'Ein ausreichend langer Beispieltext für den Chunk. ' + extra, vector };
}

test('findRedundantPairs: findet ähnliches Paar über Schwelle', () => {
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(2, 0, [0.99, 0.01, 0]), // fast identisch zu 1 → Treffer
    chunk(3, 0, [0, 1, 0]),       // orthogonal → kein Treffer
  ];
  const { pairs } = findRedundantPairs(chunks, { threshold: 0.9 });
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a_id, pairs[0].b_id], [1, 2]);
  assert.ok(pairs[0].score >= 0.9);
});

test('findRedundantPairs: gleiche Entität wird nie verglichen', () => {
  const chunks = [
    chunk(5, 0, [1, 0, 0]),
    chunk(5, 1, [1, 0, 0]), // identisch, aber selbe Seite → skip
  ];
  const { pairs, comparedPairs } = findRedundantPairs(chunks, { threshold: 0.5 });
  assert.equal(pairs.length, 0);
  assert.equal(comparedPairs, 0);
});

test('findRedundantPairs: bester Chunk pro Seitenpaar, nur einmal gelistet', () => {
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(1, 1, [0.8, 0.2, 0]),
    chunk(2, 0, [1, 0, 0]),       // beste Übereinstimmung mit 1/chunk0
    chunk(2, 1, [0.7, 0.3, 0]),
  ];
  const { pairs } = findRedundantPairs(chunks, { threshold: 0.5 });
  assert.equal(pairs.length, 1, 'Seitenpaar 1↔2 nur einmal');
  assert.equal(pairs[0].score, 1, 'nimmt den stärksten Chunk-Treffer');
});

test('finalizePairs: topK kappt + setzt truncated', () => {
  // Drei Seiten, alle paarweise ähnlich → 3 Paare; topK=2.
  const chunks = [
    chunk(1, 0, [1, 0, 0]),
    chunk(2, 0, [0.99, 0.01, 0]),
    chunk(3, 0, [0.98, 0.02, 0]),
  ];
  const { vecs, metas } = prepare(chunks);
  const best = new Map();
  scanBlock(vecs, metas, 0, vecs.length, 0.9, best);
  const { pairs, totalFound, truncated } = finalizePairs(best, metas, { topK: 2 });
  assert.equal(totalFound, 3);
  assert.equal(pairs.length, 2);
  assert.equal(truncated, true);
  // Nach Score absteigend sortiert.
  assert.ok(pairs[0].score >= pairs[1].score);
});

test('prepare: zu kurze Chunks + Nullvektoren fallen raus', () => {
  const chunks = [
    { entity_id: 1, chunk_ix: 0, text: 'kurz', vector: [1, 0, 0] },        // < MIN_CHARS
    { entity_id: 2, chunk_ix: 0, text: 'x'.repeat(60), vector: [0, 0, 0] }, // Nullvektor
    chunk(3, 0, [1, 0, 0]),                                                  // ok
  ];
  const { vecs, metas } = prepare(chunks);
  assert.equal(vecs.length, 1);
  assert.equal(metas[0].entity_id, 3);
});

// ── Figuren-Dubletten ────────────────────────────────────────────────────────
function fig(id, name, vector) {
  return { id, name, vector };
}

test('findFigureDuplicates: nahe Vektoren über Schwelle werden ein Paar', () => {
  const figs = [
    fig(1, 'Berthold', [1, 0, 0]),
    fig(2, 'Der Alte', [0.99, 0.02, 0]), // fast identisch, anderer Name
    fig(3, 'Mara', [0, 1, 0]),           // orthogonal → kein Treffer
  ];
  const { pairs, totalFound } = findFigureDuplicates(figs, { threshold: 0.9 });
  assert.equal(totalFound, 1);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a_id, pairs[0].b_id], [1, 2]);
});

test('findFigureDuplicates: gleiche/überlappende Namen → duplicate, verschiedene → alias', () => {
  const figs = [
    fig(1, 'Anna Meier', [1, 0, 0]),
    fig(2, 'Anna Meyer', [1, 0, 0]),      // Token „anna" geteilt → duplicate
    fig(3, 'Konrektor Zangl', [0, 1, 0]),
    fig(4, 'Der Zauberer', [0, 1, 0]),    // kein geteiltes Token → alias
  ];
  const { pairs } = findFigureDuplicates(figs, { threshold: 0.9 });
  const byPair = Object.fromEntries(pairs.map(p => [`${p.a_id}${p.b_id}`, p.dupeKind]));
  assert.equal(byPair['12'], 'duplicate');
  assert.equal(byPair['34'], 'alias');
});

test('findFigureDuplicates: alias-Paare zuerst (das nicht-triviale Signal)', () => {
  const figs = [
    fig(1, 'Anna Meier', [1, 0, 0]),
    fig(2, 'Anna Meier', [1, 0, 0]),   // duplicate (Score 1.0)
    fig(3, 'Xaver', [0, 1, 0]),
    fig(4, 'Der Fremde', [0, 0.99, 0.01]), // alias (Score < 1.0)
  ];
  const { pairs } = findFigureDuplicates(figs, { threshold: 0.9 });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].dupeKind, 'alias', 'alias trotz niedrigerem Score zuerst');
  assert.equal(pairs[1].dupeKind, 'duplicate');
});

test('findFigureDuplicates: leere/1er-Liste + Nullvektor → keine Paare', () => {
  assert.equal(findFigureDuplicates([]).totalFound, 0);
  assert.equal(findFigureDuplicates([fig(1, 'A', [1, 0])]).totalFound, 0);
  const withZero = findFigureDuplicates([fig(1, 'A', [0, 0, 0]), fig(2, 'B', [1, 0, 0])], { threshold: 0.5 });
  assert.equal(withZero.totalFound, 0, 'Nullvektor fällt raus → kein Vergleichspartner');
});

test('scanBlock: blockweiser Scan == Voll-Scan (Zerlegung ändert Ergebnis nicht)', () => {
  const chunks = [];
  // Deterministische, verschiedene Vektoren über mehrere Seiten.
  for (let e = 1; e <= 8; e++) {
    chunks.push(chunk(e, 0, [Math.cos(e), Math.sin(e), e / 10]));
  }
  const { vecs, metas } = prepare(chunks);

  const full = new Map();
  scanBlock(vecs, metas, 0, vecs.length, 0.5, full);

  const blocked = new Map();
  for (let i = 0; i < vecs.length; i += 3) {
    scanBlock(vecs, metas, i, Math.min(i + 3, vecs.length), 0.5, blocked);
  }
  assert.deepEqual(
    finalizePairs(full, metas, { topK: 100 }).pairs,
    finalizePairs(blocked, metas, { topK: 100 }).pairs,
  );
});

// ── Filter, Fortschritt, Blockgrösse ────────────────────────────────────────
import { pairsBefore, nextBlockEnd, unitVector, FIGURE_DUPE_THRESHOLD } from '../../lib/redundancy.js';

test('scanBlock skipPair: gefilterte Paare fallen heraus, a < b wird übergeben', () => {
  const chunks = [
    chunk(3, 0, [1, 0, 0]),
    chunk(1, 0, [1, 0, 0]),
    chunk(2, 0, [1, 0, 0]),
  ];
  const seen = [];
  const { pairs } = findRedundantPairs(chunks, {
    threshold: 0.9,
    skipPair: (a, b) => { seen.push([a, b]); return a === 1 && b === 3; },
  });
  assert.ok(seen.every(([a, b]) => a < b), 'Entitäts-IDs normiert');
  assert.deepEqual(pairs.map(p => `${p.a_id}:${p.b_id}`).sort(), ['1:2', '2:3']);
});

test('finalizePairs: liefert den Passagentext (gekappt) statt nur ein Snippet', () => {
  const long = 'x'.repeat(2000);
  const chunks = [
    { entity_id: 1, chunk_ix: 0, text: long, vector: [1, 0] },
    { entity_id: 2, chunk_ix: 0, text: long, vector: [1, 0] },
  ];
  const { pairs } = findRedundantPairs(chunks, { threshold: 0.9, textChars: 1500 });
  assert.equal(pairs[0].a_text.length, 1500);
  assert.equal(pairs[0].b_text.length, 1500);
});

test('pairsBefore: Dreieckszahl, Randfälle', () => {
  assert.equal(pairsBefore(5, 0), 0);
  assert.equal(pairsBefore(5, 1), 4);
  assert.equal(pairsBefore(5, 5), 10);
  assert.equal(pairsBefore(5, 99), 10, 'über n hinaus gekappt');
});

test('nextBlockEnd: deckt alle Zeilen ab, hält das Paar-Budget, mindestens eine Zeile', () => {
  const n = 1000;
  const budget = 5000;
  let i = 0;
  let blocks = 0;
  while (i < n) {
    const end = nextBlockEnd(n, i, budget);
    assert.ok(end > i, 'Fortschritt');
    const pairs = pairsBefore(n, end) - pairsBefore(n, i);
    assert.ok(end - i === 1 || pairs <= budget, `Block ${i}-${end} hält Budget`);
    i = end;
    blocks++;
  }
  assert.equal(i, n);
  assert.ok(blocks < n, 'späte Zeilen werden zusammengefasst');
  assert.equal(nextBlockEnd(n, 0, 1), 1, 'Budget kleiner als eine Zeile → genau eine Zeile');
});

test('unitVector: Einheitslänge, null bei leer/Null', () => {
  const u = unitVector([3, 4]);
  assert.ok(Math.abs(u[0] - 0.6) < 1e-6 && Math.abs(u[1] - 0.8) < 1e-6);
  assert.equal(unitVector([0, 0]), null);
  assert.equal(unitVector([]), null);
  assert.equal(unitVector(null), null);
});

test('findFigureDuplicates: Default-Schwelle = FIGURE_DUPE_THRESHOLD, skipPair filtert', () => {
  const figs = [fig(1, 'A', [1, 0]), fig(2, 'B', [0.995, 0.1])]; // Cosinus ≈ 0.995
  assert.equal(findFigureDuplicates(figs).totalFound, 1);
  assert.equal(findFigureDuplicates(figs, { skipPair: (a, b) => a === 1 && b === 2 }).totalFound, 0);
  const below = [fig(1, 'A', [1, 0]), fig(2, 'B', [Math.cos(0.6), Math.sin(0.6)])]; // ≈ 0.825
  assert.ok(0.825 < FIGURE_DUPE_THRESHOLD);
  assert.equal(findFigureDuplicates(below).totalFound, 0);
});

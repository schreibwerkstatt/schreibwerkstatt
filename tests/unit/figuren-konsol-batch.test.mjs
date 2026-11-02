// Teil-Konsolidierung der Figuren (routes/jobs/komplett/phases/figuren-konsol.js):
//   1. planKonsolBatches — Namensverwandte bleiben im selben Teil, kein Teil über dem Ziel
//      (ausser eine einzelne Figur ist selbst grösser), keine Figur geht verloren.
//   2. mergeKonsolParts — global eindeutige ids, Beziehungen über Namen gebunden, Kanten
//      zu Figuren anderer Teile aus der Eingabe übernommen.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'figuren-konsol-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require_('../../db/connection');
require_('../../db/migrations').runMigrations();
const { planKonsolBatches, mergeKonsolParts } = require_('../../routes/jobs/komplett/phases/figuren-konsol');
after(() => rmSync(dir, { recursive: true, force: true }));

const fig = (id, name, extra = {}) => ({ id, name, beschreibung: 'x'.repeat(400), ...extra });
const names = (batch) => batch.flatMap(cf => cf.figuren.map(f => f.name)).sort();

test('planKonsolBatches: Namensverwandte bleiben zusammen, nichts geht verloren', () => {
  const chapters = [
    { kapitel: 'A', figuren: [fig('fig_1', 'Hans Meier'), fig('fig_2', 'Anna Weber'), fig('fig_3', 'Paul Graf')] },
    { kapitel: 'B', figuren: [fig('fig_1', 'Frau Meier'), fig('fig_2', 'Anna'), fig('fig_3', 'Lea Huber')] },
  ];
  const batches = planKonsolBatches(chapters, 1100);
  assert.ok(batches.length > 1, 'sollte teilen');
  const all = batches.flatMap(names).sort();
  assert.deepEqual(all, ['Anna', 'Anna Weber', 'Frau Meier', 'Hans Meier', 'Lea Huber', 'Paul Graf']);
  const batchOf = (n) => batches.findIndex(b => names(b).includes(n));
  assert.equal(batchOf('Hans Meier'), batchOf('Frau Meier'));
  assert.equal(batchOf('Anna'), batchOf('Anna Weber'));
  // Kapitel-Format bleibt erhalten (der Prompt-Builder liest es unverändert).
  for (const b of batches) for (const cf of b) assert.ok(['A', 'B'].includes(cf.kapitel));
});

test('planKonsolBatches: Teile respektieren das Ziel', () => {
  const chapters = [{ kapitel: 'A', figuren: Array.from({ length: 20 }, (_, i) => fig(`fig_${i}`, `Person${i} Nachname${i}`)) }];
  const size = Math.max(...chapters[0].figuren.map(f => JSON.stringify(f).length));
  const batches = planKonsolBatches(chapters, size * 5);
  assert.equal(batches.length, 4);
  for (const b of batches) assert.ok(b[0].figuren.length <= 5);
});

test('planKonsolBatches: eine zu grosse Namensgruppe wird zerlegt statt das Ziel zu sprengen', () => {
  const chapters = [{ kapitel: 'A', figuren: Array.from({ length: 6 }, (_, i) => fig(`fig_${i}`, `Meier ${'abcdef'[i]}x`)) }];
  const size = JSON.stringify(chapters[0].figuren[0]).length;
  const batches = planKonsolBatches(chapters, size * 2);
  assert.equal(batches.length, 3);
});

test('mergeKonsolParts: eindeutige ids, Beziehungen über Namen, Kanten über Teilgrenzen', () => {
  const inputA = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Hans Meier', { beziehungen: [{ figur_id: 'fig_9', name: 'Anna Weber', typ: 'freund' }] }),
    fig('fig_2', 'Frau Meier'),
  ] }];
  const inputB = [{ kapitel: 'B', figuren: [fig('fig_1', 'Anna Weber')] }];
  const parts = [
    // KI-Ergebnis Teil A: eigene ids, In-Teil-Kante per id; die Kante zu Anna fehlt.
    { input: inputA, figuren: [
      { id: 'fig_1', name: 'Hans Meier', beziehungen: [{ figur_id: 'fig_2', typ: 'ehe' }] },
      { id: 'fig_2', name: 'Frau Meier', beziehungen: [{ figur_id: 'fig_1', typ: 'ehe' }] },
    ] },
    { input: inputB, figuren: [{ id: 'fig_1', name: 'Anna Weber', beziehungen: [] }] },
  ];
  const out = mergeKonsolParts(parts, null);
  assert.deepEqual(out.map(f => f.id), ['fig_1', 'fig_2', 'fig_3']);
  const hans = out.find(f => f.name === 'Hans Meier');
  const anna = out.find(f => f.name === 'Anna Weber');
  const frau = out.find(f => f.name === 'Frau Meier');
  assert.deepEqual(hans.beziehungen.map(b => b.figur_id).sort(), [anna.id, frau.id].sort());
  assert.deepEqual(frau.beziehungen.map(b => b.figur_id), [hans.id]);
  // Eingabe unverändert.
  assert.equal(inputA[0].figuren[0].beziehungen.length, 1);
  assert.equal(inputA[0].figuren[0].id, 'fig_1');
});

test('mergeKonsolParts: Kante auf eine unbekannte id ohne Namen fällt weg', () => {
  const input = [{ kapitel: 'A', figuren: [fig('fig_1', 'Hans')] }];
  const out = mergeKonsolParts([{ input, figuren: [{ id: 'fig_1', name: 'Hans', beziehungen: [{ figur_id: 'fig_77', typ: 'x' }] }] }], null);
  assert.deepEqual(out[0].beziehungen, []);
});

// ── 3. runKonsolBatched: Ablauf mit gefälschtem ctx ─────────────────────────────
const { runKonsolBatched } = require_('../../routes/jobs/komplett/phases/figuren-konsol');

function makeCtx(onCall) {
  const calls = [];
  return {
    jobId: 'job-konsol', bookName: 'Testbuch', tok: {}, warnings: [],
    log: { info() {}, warn() {} },
    sys: { SYSTEM_FIGUREN_BLOCKS: [] },
    prompts: {
      SCHEMA_FIGUREN_KONSOL: {},
      buildFiguresBasisConsolidationPrompt: (_b, input) => input,
    },
    call: async (_job, _tok, input) => { calls.push(input); return onCall(input, calls.length); },
    _calls: calls,
  };
}
// Gibt die Eingabe als «konsolidiert» zurück, mit frischen Teil-ids.
const echo = (input) => ({ figuren: input.flatMap(cf => cf.figuren).map((f, i) => ({ ...f, id: `fig_${i + 1}` })) });
const chapters = (n) => [{ kapitel: 'A', figuren: Array.from({ length: n }, (_, i) => fig(`fig_${i}`, `Person${i} Nachname${i}`)) }];
const OPTS = { cap: 1000, charsPerToken: 4, fromPct: 30, toPct: 40 }; // Ziel ≥ 20000 Zeichen je Teil

test('runKonsolBatched: alle Figuren kommen mit eindeutigen ids zurück', async () => {
  const ctx = makeCtx(echo);
  const { figuren, degraded } = await runKonsolBatched(ctx, chapters(120), OPTS);
  assert.equal(figuren.length, 120);
  assert.equal(new Set(figuren.map(f => f.id)).size, 120);
  assert.ok(ctx._calls.length > 1, 'sollte in mehreren Teilen laufen');
  assert.equal(degraded, false);
});

test('runKonsolBatched: truncierender Teil wird halbiert, scheiternder regelbasiert übernommen', async () => {
  const trunc = Object.assign(new Error('job.error.aiTruncated'), {});
  const ctx = makeCtx((input, n) => {
    if (n === 1) throw trunc;            // erster Teil truncierte → Halbierung
    if (n === 2) throw new Error('boom'); // erste Hälfte scheitert endgültig
    return echo(input);
  });
  const { figuren, degraded } = await runKonsolBatched(ctx, chapters(120), { ...OPTS, cap: 1000 });
  assert.equal(figuren.length, 120, 'keine Figur geht verloren');
  assert.equal(degraded, true);
});

test('runKonsolBatched: scheitert jeder Teil, wirft es (Aufrufer fällt zurück)', async () => {
  const ctx = makeCtx(() => { throw new Error('boom'); });
  await assert.rejects(runKonsolBatched(ctx, chapters(120), OPTS));
});

test('mergeKonsolParts: Figur eines anderen Teils (nur Beziehungsziel) wird verworfen, neuer kanonischer Name bleibt', () => {
  const inputA = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Hans Meier', { beziehungen: [{ name: 'Anna Weber', typ: 'freund' }] }),
    fig('fig_2', 'Hansi'),
  ] }];
  const inputB = [{ kapitel: 'B', figuren: [fig('fig_1', 'Anna Weber', { beschreibung: 'voller Steckbrief' })] }];
  const parts = [
    // Teil A erfindet einen dünnen Eintrag für das Beziehungsziel Anna Weber und
    // fasst Hans/Hansi unter einem neuen kanonischen Namen zusammen.
    { input: inputA, figuren: [
      { id: 'fig_1', name: 'Johann «Hansi» Meier', beziehungen: [{ name: 'Anna Weber', typ: 'freund' }] },
      { id: 'fig_2', name: 'Anna Weber', beschreibung: 'dünn', beziehungen: [] },
    ] },
    { input: inputB, figuren: [{ id: 'fig_1', name: 'Anna Weber', beschreibung: 'voller Steckbrief', beziehungen: [] }] },
  ];
  const out = mergeKonsolParts(parts, null);
  const annas = out.filter(f => f.name === 'Anna Weber');
  assert.equal(annas.length, 1, 'Anna nur einmal');
  assert.equal(annas[0].beschreibung, 'voller Steckbrief', 'der Eintrag ihres eigenen Teils gewinnt');
  assert.ok(out.some(f => f.name === 'Johann «Hansi» Meier'), 'neuer kanonischer Name bleibt');
  const hans = out.find(f => f.name === 'Johann «Hansi» Meier');
  assert.deepEqual(hans.beziehungen.map(b => b.figur_id), [annas[0].id], 'Kante zeigt auf die echte Anna');
});

test('mergeKonsolParts: erfundene id für ein Ziel aus einem anderen Teil wird über die Beschreibung korrigiert', () => {
  // Prod-Fall «Der Amoklauf»: Peter (Vater) liegt in einem anderen Teil als Stefan. Das
  // Modell erfindet für Peter eine id, die im eigenen Teil Adrian (Bruder) trägt.
  const VATER = 'Ein distanzierter, lesender Vater, der ihm bei der Stellensuche hilft.';
  const inputA = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Stefan', { beziehungen: [
      { figur_id: 'fig_4', name: 'Peter', typ: 'elternteil', beschreibung: VATER },
      { figur_id: 'fig_5', name: 'Adrian', typ: 'geschwister', beschreibung: 'Der jüngere Bruder, mit dem er unzertrennlich ist.' },
    ] }),
    fig('fig_5', 'Adrian'),
  ] }];
  const inputB = [{ kapitel: 'A', figuren: [fig('fig_4', 'Peter')] }];
  const parts = [
    { input: inputA, figuren: [
      { id: 'fig_1', name: 'Stefan', beziehungen: [
        { figur_id: 'fig_2', typ: 'elternteil', beschreibung: VATER },
        { figur_id: 'fig_2', typ: 'geschwister', beschreibung: 'Der jüngere Bruder, mit dem er unzertrennlich ist.' },
      ] },
      { id: 'fig_2', name: 'Adrian', beziehungen: [] },
    ] },
    { input: inputB, figuren: [{ id: 'fig_1', name: 'Peter', beziehungen: [] }] },
  ];
  const out = mergeKonsolParts(parts, null);
  const id = (n) => out.find(f => f.name === n).id;
  const stefan = out.find(f => f.name === 'Stefan');
  const byTyp = Object.fromEntries(stefan.beziehungen.map(b => [b.typ, b.figur_id]));
  assert.equal(byTyp.elternteil, id('Peter'), 'Vater zeigt auf Peter, nicht auf Adrian');
  assert.equal(byTyp.geschwister, id('Adrian'));
  assert.equal(stefan.beziehungen.filter(b => b.beschreibung === VATER).length, 1, 'Beschreibung nicht doppelt');
});

test('mergeKonsolParts: Ziel im eigenen Teil bleibt, auch bei gleicher Beschreibung wie in der Eingabe', () => {
  // Das Modell sah beide Figuren und hat «Hansi» in «Hans Meier» aufgehen lassen.
  const D = 'Der beste Freund aus der Schulzeit, mit dem er alles teilt.';
  const input = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Lea', { beziehungen: [{ figur_id: 'fig_2', name: 'Hansi', typ: 'freund', beschreibung: D }] }),
    fig('fig_2', 'Hansi'), fig('fig_3', 'Hans Meier'),
  ] }];
  const out = mergeKonsolParts([{ input, figuren: [
    { id: 'fig_1', name: 'Lea', beziehungen: [{ figur_id: 'fig_2', name: 'Hans Meier', typ: 'freund', beschreibung: D }] },
    { id: 'fig_2', name: 'Hans Meier', beziehungen: [] },
  ] }], null);
  const lea = out.find(f => f.name === 'Lea');
  assert.deepEqual(lea.beziehungen.map(b => b.figur_id), [out.find(f => f.name === 'Hans Meier').id]);
});

test('mergeKonsolParts: Rohname auf umbenannten Namensvetter, Rohnamen-Kante aus der Eingabe nicht doppelt', () => {
  // Das Modell trennt die Sebastians und nennt einen «Sebastian (Mitlehrling)»; die
  // Kante trägt (wie die Eingabe) den Rohnamen. Ohne Auflösung bände «Sebastian» an
  // den Vetter, und die Eingabe-Kante käme als Kopie dazu.
  const D = 'Mitlehrling, der ihm vermittelt, dass man stets eine Rolle spiele.';
  const inputA = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Fabio', { beziehungen: [{ figur_id: 'fig_9', name: 'Sebastian', typ: 'kollege', beschreibung: D }] }),
    fig('fig_9', 'Sebastian'),
  ] }];
  // Der Vetter steht als eigener Eintrag in Teil B (anderer Sebastian, Vollname «Sebastian»).
  const inputB = [{ kapitel: 'B', figuren: [fig('fig_1', 'Sebastian')] }];
  const out = mergeKonsolParts([
    { input: inputA, figuren: [
      { id: 'fig_1', name: 'Fabio', beziehungen: [{ figur_id: 'fig_2', name: 'Sebastian', typ: 'kollege', beschreibung: D }] },
      { id: 'fig_2', name: 'Sebastian (Mitlehrling)', kurzname: 'Sebastian', beziehungen: [] },
    ] },
    { input: inputB, figuren: [{ id: 'fig_1', name: 'Sebastian', beziehungen: [] }] },
  ], null);
  const fabio = out.find(f => f.name === 'Fabio');
  const mitlehrling = out.find(f => f.name === 'Sebastian (Mitlehrling)');
  assert.deepEqual(fabio.beziehungen.map(b => b.figur_id), [mitlehrling.id]);
});

test('mergeKonsolParts: Eingabe-Kante mit Rohnamen kommt nicht dazu, wenn die KI-Kante dieselbe Beschreibung trägt', () => {
  // Robert und die Kochs in verschiedenen Teilen; Teil B trennt «Herr Koch» in zwei
  // Figuren mit Zusatz, die KI-Kante in Teil A nennt den neuen Namen.
  const PRIM = 'Der Primarlehrer fördert Robert mit Zusatzaufgaben und empfiehlt ihn fürs Gymnasium.';
  const inputA = [{ kapitel: 'A', figuren: [
    fig('fig_1', 'Robert', { beziehungen: [{ name: 'Herr Koch', typ: 'mentor', beschreibung: PRIM }] }),
  ] }];
  const inputB = [{ kapitel: 'B', figuren: [fig('fig_1', 'Herr Koch')] }];
  const out = mergeKonsolParts([
    { input: inputA, figuren: [
      { id: 'fig_1', name: 'Robert', beziehungen: [{ figur_id: '', name: 'Herr Koch (Primarlehrer)', typ: 'mentor', beschreibung: PRIM }] },
    ] },
    { input: inputB, figuren: [
      // Frohheim zuerst: ein Rohname «Herr Koch» bände an den ersten Kurznamen-Treffer.
      { id: 'fig_1', name: 'Herr Koch (Frohheim)', kurzname: 'Herr Koch', beziehungen: [] },
      { id: 'fig_2', name: 'Herr Koch (Primarlehrer)', kurzname: 'Herr Koch', beziehungen: [] },
    ] },
  ], null);
  const robert = out.find(f => f.name === 'Robert');
  assert.equal(robert.beziehungen.length, 1);
  assert.equal(robert.beziehungen[0].figur_id, out.find(f => f.name === 'Herr Koch (Primarlehrer)').id);
});

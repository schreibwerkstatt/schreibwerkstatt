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

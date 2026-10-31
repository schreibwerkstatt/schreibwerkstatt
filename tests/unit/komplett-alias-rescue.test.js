'use strict';
// Komplettanalyse: Pflichtfeld-/Plausibilitäts-Prüfung der zwei Namens-KI-Pässe.
//   * applyAliasClusters (F3): ein Cluster mit einem Namen, der nicht unter den
//     Kandidaten stand, ist (teilweise) erfunden und wird ganz verworfen.
//   * resolveRemapNames (Remap-Rescue): ohne `zuordnungen`-Array ist die Antwort
//     ungültig → Fehler (non-fatal geloggt), nicht still «nichts zuzuordnen».

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('komplett-alias-rescue');
require('../../db/migrations');

const { applyAliasClusters } = require('../../routes/jobs/komplett/figuren-merge');
const { resolveRemapNames, resolveRemapOrtNames } = require('../../routes/jobs/komplett/job-shared');

function captureLog() {
  const warns = [];
  return { warns, log: { info() {}, warn(m) { warns.push(m); } } };
}

test('applyAliasClusters: erfundener kanonischer Name → Cluster verworfen', () => {
  const { warns, log } = captureLog();
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'der Alte' }, { id: 'fig_2', name: 'Gregor' }] },
  ];
  const { renamed, aliasMap } = applyAliasClusters(chapterFiguren,
    [{ kanonisch: 'Gregor Wassermann', aliase: ['der Alte', 'Gregor'] }], log);
  assert.equal(renamed, 0);
  assert.deepEqual(aliasMap, {});
  assert.equal(chapterFiguren[0].figuren[0].name, 'der Alte');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Gregor Wassermann/);
});

test('applyAliasClusters: erfundener Alias → Cluster verworfen, gültige Cluster wirken weiter', () => {
  const { log } = captureLog();
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'Gregor Wassermann' }, { id: 'fig_2', name: 'der Alte' }] },
    { kapitel: 'K2', figuren: [{ id: 'fig_1', name: 'Anna Weber' }, { id: 'fig_2', name: 'Annchen' }] },
  ];
  const { renamed, aliasMap } = applyAliasClusters(chapterFiguren, [
    { kanonisch: 'Gregor Wassermann', aliase: ['der Alte', 'der Greis'] },
    { kanonisch: 'Anna Weber', aliase: ['Annchen'] },
  ], log);
  assert.equal(renamed, 1);
  assert.deepEqual(aliasMap, { annchen: 'Anna Weber' });
  assert.equal(chapterFiguren[0].figuren[1].name, 'der Alte');
  assert.equal(chapterFiguren[1].figuren[1].name, 'Anna Weber');
});

function rescueCtx(callResult) {
  const { warns, log } = captureLog();
  return {
    warns,
    ctx: {
      jobId: 'test-job', tok: { in: 0, out: 0 }, bookName: 'B', log, effectiveProvider: 'claude',
      prompts: { buildNameResolutionPrompt: () => 'p', SCHEMA_NAME_RESOLUTION: {} },
      sys: { SYSTEM_FIGUREN_BLOCKS: [] },
      call: async () => callResult,
    },
  };
}
const rescueInput = () => ({
  chapterSzenen: [{ kapitel: 'K1', szenen: [{ figuren_namen: ['Annchen'] }] }],
  chapterAssignments: [],
  figuren: [{ id: 'fig_1', name: 'Anna Weber' }],
  figNameToId: { 'Anna Weber': 'fig_1' },
  figNameToIdLower: { 'anna weber': 'fig_1' },
});

test('resolveRemapNames: fehlendes zuordnungen-Array wird als Fehler gemeldet (non-fatal)', async () => {
  const { ctx, warns } = rescueCtx({ etwas: 'anderes' });
  const input = rescueInput();
  const added = await resolveRemapNames(ctx, input);
  assert.equal(added, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /nameResolutionMissing/);
  assert.equal(input.figNameToIdLower.annchen, undefined);
});

test('resolveRemapNames: gültige Zuordnung wird als Alias eingespeist', async () => {
  const { ctx, warns } = rescueCtx({ zuordnungen: [{ name: 'Annchen', treffer: 'Anna Weber' }] });
  const input = rescueInput();
  const added = await resolveRemapNames(ctx, input);
  assert.equal(added, 1);
  assert.equal(warns.length, 0);
  assert.equal(input.figNameToIdLower.annchen, 'fig_1');
});

test('resolveRemapOrtNames: umbenannter Ort aus Szenen wird dem Katalog zugeordnet', async () => {
  const seen = {};
  const { log } = captureLog();
  const ctx = {
    jobId: 'test-job', tok: { in: 0, out: 0 }, bookName: 'B', log, effectiveProvider: 'claude',
    prompts: {
      buildNameResolutionPrompt: (_b, unknown, catalog, kind) => { Object.assign(seen, { unknown, catalog, kind }); return 'p'; },
      SCHEMA_NAME_RESOLUTION: {},
    },
    sys: { SYSTEM_FIGUREN_BLOCKS: ['fig'], SYSTEM_ORTE_BLOCKS: ['ort'] },
    call: async (_j, _t, _p, sysBlocks) => { seen.sys = sysBlocks; return { zuordnungen: [
      { name: 'Rumpel-Restaurant', treffer: 'Rumpel' },
      { name: 'Strassenstrich', treffer: '' },
    ] }; },
  };
  const input = {
    chapterSzenen: [{ kapitel: 'K1', szenen: [
      { orte_namen: ['Rumpel-Restaurant', 'Strassenstrich', 'Frohheim'] },
    ] }],
    orte: [{ id: 'ort_1', name: 'Rumpel' }, { id: 'ort_2', name: 'Frohheim' }],
    ortNameToId: { Rumpel: 'ort_1', Frohheim: 'ort_2' },
    ortNameToIdLower: { rumpel: 'ort_1', frohheim: 'ort_2' },
  };
  const added = await resolveRemapOrtNames(ctx, input);
  assert.equal(added, 1);
  assert.equal(seen.kind, 'ort');
  assert.deepEqual(seen.sys, ['ort'], 'Orte-System-Prompt');
  assert.deepEqual(seen.unknown, ['Rumpel-Restaurant', 'Strassenstrich'], 'nur unauflösbare Namen');
  assert.equal(input.ortNameToIdLower['rumpel-restaurant'], 'ort_1');
  assert.equal(input.ortNameToIdLower.strassenstrich, undefined);
});

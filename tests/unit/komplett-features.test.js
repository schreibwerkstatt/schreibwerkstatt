'use strict';
// Pure-Helper der Komplettanalyse-Verbesserungen (F1–F5): Coverage-Score/-Sampling (F2),
// Alias-Cluster + Alias-Lookup-Registrierung (F3), Konsolidierungs-Signatur (F5).
// Reine Funktionen ohne KI/Alpine → schnell + deterministisch.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  sampleChapters, computeCoverageScore, buildConsolidationSig, buildFigNameLookup,
} = require('../../routes/jobs/komplett/utils.js');
const { applyAliasClusters } = require('../../routes/jobs/komplett/figuren-merge.js');

const noopLog = { info() {}, warn() {} };

function groupsFrom(list) {
  const groups = new Map();
  const groupOrder = [];
  for (const g of list) { groups.set(g.key, { name: g.name, pages: g.pages }); groupOrder.push(g.key); }
  return { groups, groupOrder };
}

// ── F2: computeCoverageScore ─────────────────────────────────────────────────
test('computeCoverageScore: erkannt/(erkannt+fehlend), gerundet auf 2 Stellen', () => {
  const cov = computeCoverageScore([
    { erkannte_figuren: 3, fehlende_figuren: ['X'], erkannte_orte: 1, fehlende_orte: [] },
    { erkannte_figuren: 5, fehlende_figuren: [], erkannte_orte: 0, fehlende_orte: ['Y'] },
  ]);
  // erkannt = 3+1+5+0 = 9; fehlend = 1+1 = 2; score = 9/11 = 0.818 → 0.82
  assert.equal(cov.erkannt, 9);
  assert.equal(cov.fehlend, 2);
  assert.equal(cov.score, 0.82);
  assert.deepEqual(cov.missingFiguren, ['X']);
  assert.deepEqual(cov.missingOrte, ['Y']);
});

test('computeCoverageScore: leere Stichprobe → score null (keine Entitäten)', () => {
  const cov = computeCoverageScore([{ erkannte_figuren: 0, fehlende_figuren: [], erkannte_orte: 0, fehlende_orte: [] }]);
  assert.equal(cov.score, null);
});

test('computeCoverageScore: dedupliziert fehlende Namen', () => {
  const cov = computeCoverageScore([
    { erkannte_figuren: 1, fehlende_figuren: ['A', 'A'], erkannte_orte: 0, fehlende_orte: [] },
  ]);
  assert.deepEqual(cov.missingFiguren, ['A']);
});

// ── F2: sampleChapters ───────────────────────────────────────────────────────
test('sampleChapters: gleichmässig verteilt, nur nicht-leere Kapitel, deterministisch', () => {
  const { groups, groupOrder } = groupsFrom([
    { key: 1, name: 'K1', pages: [{ title: 'S1', text: 'Text eins' }] },
    { key: 2, name: 'K2', pages: [{ title: 'S2', text: '   ' }] }, // leer
    { key: 3, name: 'K3', pages: [{ title: 'S3', text: 'Text drei' }] },
    { key: 4, name: 'K4', pages: [{ title: 'S4', text: 'Text vier' }] },
  ]);
  const s1 = sampleChapters(groups, groupOrder, 2);
  const s2 = sampleChapters(groups, groupOrder, 2);
  assert.equal(s1.length, 2);
  assert.deepEqual(s1.map(s => s.name), s2.map(s => s.name), 'deterministisch');
  assert.ok(!s1.some(s => s.name === 'K2'), 'leeres Kapitel wird nie gesampelt');
  assert.ok(s1[0].chText.includes('### S1'));
});

test('sampleChapters: n=0 oder keine nicht-leeren → []', () => {
  const { groups, groupOrder } = groupsFrom([{ key: 1, name: 'K1', pages: [{ title: 'S', text: '' }] }]);
  assert.deepEqual(sampleChapters(groups, groupOrder, 3), []);
  const { groups: g2, groupOrder: go2 } = groupsFrom([{ key: 1, name: 'K1', pages: [{ title: 'S', text: 'x' }] }]);
  assert.deepEqual(sampleChapters(g2, go2, 0), []);
});

test('sampleChapters: kappt Kapiteltext auf maxCharsPerChapter', () => {
  const { groups, groupOrder } = groupsFrom([
    { key: 1, name: 'K1', pages: [{ title: 'S', text: 'x'.repeat(1000) }] },
  ]);
  const [s] = sampleChapters(groups, groupOrder, 1, 100);
  assert.ok(s.chText.length <= 100);
});

// ── F3: applyAliasClusters + Alias-Lookup ────────────────────────────────────
test('applyAliasClusters: Alias-Nennungen werden auf kanonischen Namen umgeschrieben, Original als kurzname', () => {
  const chapterFiguren = [
    { kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'Gregor Wassermann', beschreibung: 'alt' }] },
    { kapitel: 'K2', figuren: [{ id: 'fig_1', name: 'der Alte', beschreibung: 'greis' }] },
  ];
  const { renamed, aliasMap } = applyAliasClusters(
    chapterFiguren, [{ kanonisch: 'Gregor Wassermann', aliase: ['der Alte'] }], noopLog);
  assert.equal(renamed, 1);
  assert.equal(aliasMap['der alte'], 'Gregor Wassermann');
  assert.equal(chapterFiguren[1].figuren[0].name, 'Gregor Wassermann');
  assert.equal(chapterFiguren[1].figuren[0].kurzname, 'der Alte');
});

test('applyAliasClusters: keine Cluster → renamed 0, leere Map', () => {
  const chapterFiguren = [{ kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'Anna' }] }];
  const { renamed, aliasMap } = applyAliasClusters(chapterFiguren, [], noopLog);
  assert.equal(renamed, 0);
  assert.deepEqual(aliasMap, {});
  assert.equal(chapterFiguren[0].figuren[0].name, 'Anna');
});

test('applyAliasClusters: Alias == kanonisch wird ignoriert (kein Self-Alias)', () => {
  const chapterFiguren = [{ kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'Anna' }] }];
  const { renamed } = applyAliasClusters(chapterFiguren, [{ kanonisch: 'Anna', aliase: ['Anna'] }], noopLog);
  assert.equal(renamed, 0);
});

test('buildFigNameLookup: Alias-Name einer Szene löst auf die kanonische Figur auf', () => {
  const figuren = [{ id: 'F9', name: 'Gregor Wassermann' }];
  const aliasMap = { 'der alte': 'Gregor Wassermann' };
  const szenen = [{ kapitel: 'K2', szenen: [{ titel: 'S', figuren_namen: ['der Alte'] }] }];
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, [], [], szenen, noopLog, 1, aliasMap);
  assert.equal(figNameToId['Gregor Wassermann'], 'F9');
  assert.equal(figNameToIdLower['der alte'], 'F9', 'Alias resolves to canonical id');
});

// ── F5: buildConsolidationSig ─────────────────────────────────────────────────
const chaptersA = {
  chapterFiguren: [{ kapitel: 'K1', figuren: [{ id: 'fig_1', name: 'Anna' }] }],
  chapterOrte: [{ kapitel: 'K1', orte: [] }],
};

test('buildConsolidationSig: gleicher Input → gleiche Sig (deterministisch)', () => {
  const a = buildConsolidationSig(chaptersA, 'model:20:cp0', { model: 'm', attr: true });
  const b = buildConsolidationSig(chaptersA, 'model:20:cp0', { model: 'm', attr: true });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('buildConsolidationSig: Katalog-Änderung → andere Sig', () => {
  const a = buildConsolidationSig(chaptersA, 'v', {});
  const chaptersB = JSON.parse(JSON.stringify(chaptersA));
  chaptersB.chapterFiguren[0].figuren.push({ id: 'fig_2', name: 'Bob' });
  assert.notEqual(a, buildConsolidationSig(chaptersB, 'v', {}));
});

test('buildConsolidationSig: cacheVersion- oder Flag-Änderung → andere Sig', () => {
  const base = buildConsolidationSig(chaptersA, 'v1', { model: 'm', attr: true });
  assert.notEqual(base, buildConsolidationSig(chaptersA, 'v2', { model: 'm', attr: true }));
  assert.notEqual(base, buildConsolidationSig(chaptersA, 'v1', { model: 'm', attr: false }));
  assert.notEqual(base, buildConsolidationSig(chaptersA, 'v1', { model: 'x', attr: true }));
});

test('coverageSampleSize: Setting ist Untergrenze, ein Drittel der Kapitel, Deckel 20, 0 = aus', () => {
  const { coverageSampleSize } = require('../../routes/jobs/komplett/utils');
  assert.equal(coverageSampleSize(0, 100), 0, '0 = aus, auch bei vielen Kapiteln');
  assert.equal(coverageSampleSize(3, 5), 3, 'kleines Buch: Mindestzahl');
  assert.equal(coverageSampleSize(3, 30), 10, 'ein Drittel der Kapitel');
  assert.equal(coverageSampleSize(3, 181), 20, 'Deckel');
  assert.equal(coverageSampleSize(50, 5), 20, 'auch ein zu hohes Setting bleibt unter dem Deckel');
  assert.equal(coverageSampleSize('3', 9), 3);
});

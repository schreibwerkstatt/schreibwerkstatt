'use strict';
// Unit: Merge-/Dedup-Invarianten der Komplettanalyse-Phase 2 an konkreten Fällen.
//   * Pre-Merge trägt die Beziehungen einer entfernten Kapitel-Dublette mit
//     (sonst fehlt jede Beziehung, die erst in einem späteren Kapitel entsteht).
//   * Chunk-lokale Beziehungs-ids sind kein Indiz über Chunk-Grenzen hinweg.
//   * Ein Kurzname, der zu mehreren Vollnamen passt, verschmilzt mit keinem davon.
//   * Der Kanon trägt den vollsten Namen; idRemap-Ketten werden bis zum Ende aufgelöst.
//   * Die Beschreibungs-Prüfung erfindet keine Kanten und leert keine Beschreibungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  annotateBeziehungenNames, rebindBeziehungenByName,
  preMergeChapterFiguren, mergeDuplicateFiguren, validateBeziehungenDescriptions,
} = require('../../routes/jobs/komplett/figuren-merge');

const NOLOG = { info() {}, warn() {} };

// Fallback-Zeile aus phases/figuren.js (globale Neu-Nummerierung + Rebind).
function fallback(chunks) {
  annotateBeziehungenNames(chunks);
  const { chapterFiguren: preMerged } = preMergeChapterFiguren(chunks);
  const list = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
  rebindBeziehungenByName(list, NOLOG);
  return list;
}
const zielName = (list, von) => {
  const nameById = Object.fromEntries(list.map(f => [f.id, f.name]));
  return (list.find(f => f.name === von).beziehungen || []).map(b => nameById[b.figur_id]);
};

// ── Befund 5: Beziehungen der Kapitel-Dublette ────────────────────────────────
test('preMerge: Beziehung, die erst im späteren Kapitel entsteht, überlebt', () => {
  const chunks = [
    { kapitel: 'K1', figuren: [
      { id: 'fig_1', name: 'Anna Meier', beziehungen: [] },
      { id: 'fig_2', name: 'Bruno Keller', beziehungen: [] },
    ] },
    { kapitel: 'K5', figuren: [
      { id: 'fig_1', name: 'Anna Meier', beziehungen: [{ figur_id: 'fig_2', typ: 'freund', beschreibung: 'Bruno wird Annas Freund.' }] },
      { id: 'fig_2', name: 'Bruno Keller', beziehungen: [] },
    ] },
  ];
  const list = fallback(chunks);
  assert.equal(list.length, 2);
  assert.deepEqual(zielName(list, 'Anna Meier'), ['Bruno Keller']);
});

test('preMerge: Beziehung auf einen teilnamig gemergten Namen bleibt (Fallback-Rebind)', () => {
  const chunks = [
    { kapitel: 'K1', figuren: [
      { id: 'fig_1', name: 'Anna Weber', beruf: 'Lehrerin', kapitel: [{ name: 'K1' }], beziehungen: [] },
    ] },
    { kapitel: 'K2', figuren: [
      { id: 'fig_1', name: 'Anna', beruf: 'Lehrerin', kapitel: [{ name: 'K1' }], beziehungen: [] },
      { id: 'fig_2', name: 'Lisa', beziehungen: [{ figur_id: 'fig_1', typ: 'freund' }] },
    ] },
  ];
  const list = fallback(chunks);
  assert.deepEqual(zielName(list, 'Lisa'), ['Anna Weber']);
});

// ── Befund 6: chunk-lokale ids sind kein Indiz ────────────────────────────────
test('preMerge: «Herr Weber» und «Anna Weber» verschmelzen nicht über eine zufällig gleiche fig_2', () => {
  const chunks = [
    { kapitel: 'K1', figuren: [
      { id: 'fig_1', name: 'Herr Weber', beziehungen: [{ figur_id: 'fig_2', typ: 'kollege' }] },
      { id: 'fig_2', name: 'Max', beziehungen: [] },
    ] },
    { kapitel: 'K2', figuren: [
      { id: 'fig_1', name: 'Anna Weber', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
      { id: 'fig_2', name: 'Lisa', beziehungen: [] },
    ] },
  ];
  annotateBeziehungenNames(chunks);
  const { chapterFiguren: out, dupesRemoved } = preMergeChapterFiguren(chunks);
  assert.equal(dupesRemoved, 0);
  assert.deepEqual(out.flatMap(c => c.figuren).map(f => f.name).sort(), ['Anna Weber', 'Herr Weber', 'Lisa', 'Max']);
});

test('preMerge: gleiche Beziehungs-ZIELNAMEN zählen weiterhin als Indiz', () => {
  const chunks = [
    { kapitel: 'K1', figuren: [
      { id: 'fig_1', name: 'Anna Weber', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
      { id: 'fig_2', name: 'Max', beziehungen: [] },
    ] },
    { kapitel: 'K2', figuren: [
      { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
      { id: 'fig_2', name: 'Max', beziehungen: [] },
    ] },
  ];
  annotateBeziehungenNames(chunks);
  const { dupesRemoved } = preMergeChapterFiguren(chunks);
  assert.equal(dupesRemoved, 2); // Max exakt, Anna über Teilname + gemeinsames Ziel «Max»
});

// ── Befund 7: Kurzname zwischen zwei Vollnamen ────────────────────────────────
test('Stufe 2: «Anna» verschmilzt nicht Anna Weber und Anna Schmid zu einer Figur', () => {
  const w = { geschlecht: 'weiblich', kapitel: [{ name: 'K1' }] };
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', ...w },
    { id: 'fig_2', name: 'Anna Weber', ...w },
    { id: 'fig_3', name: 'Anna Schmid', ...w },
  ]);
  assert.deepEqual(figuren.map(f => f.name).sort(), ['Anna', 'Anna Schmid', 'Anna Weber']);
});

test('Stufe 2: eindeutiger Kurzname geht im Vollnamen auf, der Vollname ist Kanon', () => {
  const w = { geschlecht: 'weiblich', kapitel: [{ name: 'K1' }] };
  const { figuren, idRemap } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', ...w },
    { id: 'fig_2', name: 'Anna Weber', ...w },
  ]);
  assert.equal(figuren.length, 1);
  assert.equal(figuren[0].name, 'Anna Weber');
  assert.equal(figuren[0].kurzname, 'Anna');
  assert.equal(idRemap.fig_1, 'fig_2');
});

// ── Befund 8: idRemap-Ketten ──────────────────────────────────────────────────
test('mergeDuplicate: Beziehung über eine Remap-Kette (fig_7→fig_3→…) bleibt erhalten', () => {
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', geschlecht: 'w', typ: 'hauptfigur', kapitel: [{ name: 'K1' }] },
    { id: 'fig_2', name: 'Max', beziehungen: [{ figur_id: 'fig_7', typ: 'freund' }] },
    { id: 'fig_3', name: 'Anna Weber', beschreibung: 'lang lang', geschlecht: 'w', typ: 'hauptfigur', kapitel: [{ name: 'K1' }] },
    { id: 'fig_7', name: 'Anna Weber', beschreibung: 'x' },
  ]);
  assert.equal(figuren.length, 2);
  const anna = figuren.find(f => f.name === 'Anna Weber');
  const max = figuren.find(f => f.name === 'Max');
  assert.deepEqual(max.beziehungen.map(b => b.figur_id), [anna.id]);
});

test('mergeDuplicate: Kette Stufe 1 → Stufe 2 wird bis zum Kanon aufgelöst', () => {
  const w = { geschlecht: 'w', typ: 'hauptfigur', kapitel: [{ name: 'K1' }] };
  const { figuren, idRemap } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna', beschreibung: 'längere Beschreibung', ...w },
    { id: 'fig_5', name: 'Anna', ...w },
    { id: 'fig_3', name: 'Anna Weber', ...w },
    { id: 'fig_9', name: 'Max', beziehungen: [{ figur_id: 'fig_5', typ: 'freund' }] },
  ]);
  const anna = figuren.find(f => f.name === 'Anna Weber');
  assert.equal(idRemap.fig_5, anna.id);
  assert.deepEqual(figuren.find(f => f.name === 'Max').beziehungen.map(b => b.figur_id), [anna.id]);
});

// ── Befund 9: Beschreibungs-Prüfung ───────────────────────────────────────────
test('beziehungsBeschreibung: «Seine strenge Mutter …» bleibt, keine Kante wird erfunden', () => {
  const f = [
    { id: 'fig_1', name: 'Robert', beziehungen: [
      { figur_id: 'fig_2', typ: 'elternteil', beschreibung: 'Seine strenge Mutter, die ihn allein aufzog.' },
      { figur_id: 'fig_3', typ: 'vorgesetzter', beschreibung: 'Sebastian vermittelte ihm die Stelle beim Kommissar.' },
    ] },
    { id: 'fig_2', name: 'Sandra' },
    { id: 'fig_3', name: 'Herr Koch' },
    { id: 'fig_4', name: 'Sebastian' },
  ];
  const r = validateBeziehungenDescriptions(f);
  assert.equal(f[0].beziehungen.length, 2, 'keine neue Kante Robert→Sebastian');
  assert.equal(f[0].beziehungen[0].beschreibung, 'Seine strenge Mutter, die ihn allein aufzog.');
  assert.equal(f[0].beziehungen[1].beschreibung, 'Sebastian vermittelte ihm die Stelle beim Kommissar.');
  assert.equal(r.moved, 0);
  assert.equal(r.suspicious, 1);
});

test('beziehungsBeschreibung: Kurzname matcht nur als ganzes Wort', () => {
  const f = [
    { id: 'fig_1', name: 'Anna', beziehungen: [
      { figur_id: 'fig_2', typ: 'freund', beschreibung: 'Maximilian ist ihr bester Freund.' },
      { figur_id: 'fig_3', typ: 'bekannt' },
    ] },
    { id: 'fig_2', name: 'Maximilian' },
    { id: 'fig_3', name: 'Max' },
  ];
  const r = validateBeziehungenDescriptions(f);
  assert.equal(r.moved, 0);
  assert.equal(f[0].beziehungen[0].beschreibung, 'Maximilian ist ihr bester Freund.');
});

// ── buildFigNameLookup: Vollname schlägt fremden Kurznamen ────────────────────
test('buildFigNameLookup: Kurzname/Alias überschreibt keinen Vollnamen einer anderen Figur', () => {
  const { buildFigNameLookup } = require('../../routes/jobs/komplett/utils');
  const { figNameToId, figNameToIdLower } = buildFigNameLookup([
    { id: 'fig_1', name: 'Anna' },
    { id: 'fig_2', name: 'Anna Weber', kurzname: 'Anna', __aliasNamen: ['Annchen'] },
  ], [], [], [], NOLOG, 'job');
  assert.equal(figNameToId.Anna, 'fig_1');
  assert.equal(figNameToId['Anna Weber'], 'fig_2');
  assert.equal(figNameToIdLower.annchen, 'fig_2');
});

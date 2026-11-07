'use strict';
// Unit: annotateBeziehungenNames + rebindBeziehungenByName — die Beziehungs-Ziele der
// Phase-1-Extraktion überleben das globale Neu-Nummerieren der Figuren.
//
// Warum das ein eigener Test ist: `beziehungen[].figur_id` ist CHUNK-LOKAL (der
// Extraktions-Prompt verlangt pro Chunk «Eindeutige IDs (fig_1, fig_2, …)», und
// utils.js#extractField hält pro Chunk einen eigenen Eintrag). Wer die Figuren danach
// global durchnummeriert, ohne die Beziehungen mitzunehmen, bindet sie an eine FREMDE
// Figur — und db/figures/save.js#dedupRelations fängt das NICHT, weil es nur prüft, ob
// die id existiert. Unten in der DB ist der Fehler dann nicht mehr erkennbar.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  annotateBeziehungenNames, rebindBeziehungenByName,
  preMergeChapterFiguren, mergeDuplicateFiguren, ensureUniqueFigIds,
} = require('../../routes/jobs/komplett/figuren-merge');

const NOLOG = { info() {}, warn() {} };

// Drei Chunks, jeder mit eigenem ID-Namensraum ab fig_1 — so liefert Pass A sie.
function dreiChunks() {
  return [
    { kapitel: 'Chunk1', figuren: [
      { id: 'fig_1', name: 'Anna Meier', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
      { id: 'fig_2', name: 'Bruno Keller', beziehungen: [] },
    ] },
    { kapitel: 'Chunk2', figuren: [
      { id: 'fig_1', name: 'Clara Roth', beziehungen: [{ figur_id: 'fig_2', typ: 'feind' }] },
      { id: 'fig_2', name: 'Doris Weber', beziehungen: [] },
    ] },
    { kapitel: 'Chunk3', figuren: [
      { id: 'fig_1', name: 'Emil Schmid', beziehungen: [{ figur_id: 'fig_2', typ: 'kollege' }] },
      { id: 'fig_2', name: 'Fritz Brun', beziehungen: [] },
    ] },
  ];
}

test('annotateBeziehungenNames löst die id im eigenen Chunk auf', () => {
  const chunks = dreiChunks();
  assert.equal(annotateBeziehungenNames(chunks), 3);
  assert.equal(chunks[0].figuren[0].beziehungen[0].name, 'Bruno Keller');
  assert.equal(chunks[1].figuren[0].beziehungen[0].name, 'Doris Weber');
  assert.equal(chunks[2].figuren[0].beziehungen[0].name, 'Fritz Brun');
});

test('annotateBeziehungenNames greift NICHT über Chunk-Grenzen', () => {
  // Chunk2 kennt kein fig_3 → kein Name, und schon gar nicht der aus Chunk1.
  const chunks = [
    { kapitel: 'C1', figuren: [{ id: 'fig_3', name: 'Nur in C1' }] },
    { kapitel: 'C2', figuren: [{ id: 'fig_1', name: 'X', beziehungen: [{ figur_id: 'fig_3', typ: 'freund' }] }] },
  ];
  assert.equal(annotateBeziehungenNames(chunks), 0);
  assert.equal(chunks[1].figuren[0].beziehungen[0].name, undefined);
});

test('annotateBeziehungenNames überschreibt einen bestehenden Namen nicht', () => {
  const chunks = [{ kapitel: 'C1', figuren: [
    { id: 'fig_1', name: 'A', beziehungen: [{ figur_id: 'fig_2', name: 'Vorgegeben', typ: 'freund' }] },
    { id: 'fig_2', name: 'B' },
  ] }];
  assert.equal(annotateBeziehungenNames(chunks), 0);
  assert.equal(chunks[0].figuren[0].beziehungen[0].name, 'Vorgegeben');
});

// Der eigentliche Regressions-Test: der Fallback-Pfad von Phase 2 (KI-Konsolidierung
// gescheitert) nummeriert global neu. Ohne Rebind zeigten Chunk 2 und 3 auf Bruno Keller.
test('Fallback-Neunummerierung: Beziehungen bleiben an der richtigen Figur', () => {
  const chunks = dreiChunks();
  annotateBeziehungenNames(chunks);
  const { chapterFiguren: preMerged } = preMergeChapterFiguren(chunks);
  // Genau die Fallback-Zeile aus phases/figuren.js:
  let figuren = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
  const { rebound, dropped } = rebindBeziehungenByName(figuren, NOLOG);
  assert.equal(dropped, 0);
  assert.equal(rebound, 2, 'Chunk 2 und 3 müssen korrigiert werden; Chunk 1 stimmte zufällig');

  const nameById = Object.fromEntries(figuren.map(f => [f.id, f.name]));
  const ziel = (von) => nameById[figuren.find(f => f.name === von).beziehungen[0].figur_id];
  assert.equal(ziel('Anna Meier'), 'Bruno Keller');
  assert.equal(ziel('Clara Roth'), 'Doris Weber');
  assert.equal(ziel('Emil Schmid'), 'Fritz Brun');
});

test('Rebind übersteht mergeDuplicateFiguren + ensureUniqueFigIds', () => {
  const chunks = dreiChunks();
  annotateBeziehungenNames(chunks);
  const { chapterFiguren: preMerged } = preMergeChapterFiguren(chunks);
  let figuren = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
  rebindBeziehungenByName(figuren, NOLOG);
  const { figuren: merged } = mergeDuplicateFiguren(figuren);
  ensureUniqueFigIds(merged, NOLOG);
  const nameById = Object.fromEntries(merged.map(f => [f.id, f.name]));
  const clara = merged.find(f => f.name === 'Clara Roth');
  assert.equal(nameById[clara.beziehungen[0].figur_id], 'Doris Weber');
});

test('rebindBeziehungenByName entfernt unauflösbare Ziele statt sie falsch zu binden', () => {
  const figuren = [
    { id: 'fig_1', name: 'A', beziehungen: [{ figur_id: 'fig_2', name: 'Nicht im Katalog', typ: 'freund' }] },
    { id: 'fig_2', name: 'B' },
  ];
  const { rebound, dropped } = rebindBeziehungenByName(figuren, NOLOG);
  assert.equal(rebound, 0);
  assert.equal(dropped, 1);
  assert.equal(figuren[0].beziehungen.length, 0);
});

test('rebindBeziehungenByName entfernt Selbst-Referenzen', () => {
  const figuren = [{ id: 'fig_1', name: 'A', beziehungen: [{ figur_id: 'fig_9', name: 'A', typ: 'andere' }] }];
  assert.equal(rebindBeziehungenByName(figuren, NOLOG).dropped, 1);
  assert.equal(figuren[0].beziehungen.length, 0);
});

test('rebindBeziehungenByName verwirft Kanten ohne Zielnamen (chunk-lokale id nach Neunummerierung)', () => {
  // Der Rebind läuft nur dort, wo global neu nummeriert wird. Ohne Namen ist die
  // figur_id chunk-lokal und träfe die Figur, die zufällig denselben Index hat.
  const figuren = [
    { id: 'fig_1', name: 'A', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
    { id: 'fig_2', name: 'B', beziehungen: [] },
  ];
  const { rebound, dropped } = rebindBeziehungenByName(figuren, NOLOG);
  assert.equal(rebound, 0);
  assert.equal(dropped, 1);
  assert.equal(figuren[0].beziehungen.length, 0);
});

test('rebindBeziehungenByName ist idempotent', () => {
  const chunks = dreiChunks();
  annotateBeziehungenNames(chunks);
  const { chapterFiguren: preMerged } = preMergeChapterFiguren(chunks);
  const figuren = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
  rebindBeziehungenByName(figuren, NOLOG);
  const zweiter = rebindBeziehungenByName(figuren, NOLOG);
  assert.equal(zweiter.rebound, 0);
  assert.equal(zweiter.dropped, 0);
});

// preferBeziehungNames — Einzel-Call der Konsolidierung: das Modell zählt die
// Figuren-ids und die figur_id der Kanten getrennt; nach einer zusammengelegten Figur
// verrutschen die Kanten um eins. Der mitgeschriebene Zielname entscheidet.
const { preferBeziehungNames } = require('../../routes/jobs/komplett/figuren-merge');

test('preferBeziehungNames: um eins verrutschte figur_id wird über den Namen korrigiert', () => {
  const figuren = [
    { id: 'fig_1', name: 'Reto', beziehungen: [{ figur_id: 'fig_3', name: 'Retos Vater', typ: 'elternteil' }] },
    { id: 'fig_2', name: 'Retos Vater', beziehungen: [] },
    { id: 'fig_3', name: 'Stefanies Mutter', beziehungen: [] },
  ];
  assert.equal(preferBeziehungNames(figuren, NOLOG), 1);
  assert.equal(figuren[0].beziehungen[0].figur_id, 'fig_2');
});

test('preferBeziehungNames: passende id bleibt, auch bei Namensvetter mit Zusatz', () => {
  const figuren = [
    { id: 'fig_1', name: 'Robert', beziehungen: [{ figur_id: 'fig_3', name: 'Herr Koch', typ: 'mentor' }] },
    { id: 'fig_2', name: 'Herr Koch (Frohheim)', kurzname: 'Herr Koch', beziehungen: [] },
    { id: 'fig_3', name: 'Herr Koch (Primarlehrer)', kurzname: 'Herr Koch', beziehungen: [] },
  ];
  assert.equal(preferBeziehungNames(figuren, NOLOG), 0);
  assert.equal(figuren[0].beziehungen[0].figur_id, 'fig_3');
});

test('preferBeziehungNames: mehrdeutiger oder unbekannter Name lässt die id stehen', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna', beziehungen: [
      { figur_id: 'fig_4', name: 'Herr Koch', typ: 'bekannt' },
      { figur_id: 'fig_4', name: 'Niemand', typ: 'bekannt' },
    ] },
    { id: 'fig_2', name: 'Herr Koch (A)', kurzname: 'Herr Koch', beziehungen: [] },
    { id: 'fig_3', name: 'Herr Koch (B)', kurzname: 'Herr Koch', beziehungen: [] },
    { id: 'fig_4', name: 'Bruno', beziehungen: [] },
  ];
  assert.equal(preferBeziehungNames(figuren, NOLOG), 0);
  assert.deepEqual(figuren[0].beziehungen.map(b => b.figur_id), ['fig_4', 'fig_4']);
});

test('preferBeziehungNames: Name der eigenen Figur bindet keine Selbstkante', () => {
  const figuren = [
    { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', name: 'Anna', typ: 'freund' }] },
    { id: 'fig_2', name: 'Bruno', beziehungen: [] },
  ];
  assert.equal(preferBeziehungNames(figuren, NOLOG), 0);
  assert.equal(figuren[0].beziehungen[0].figur_id, 'fig_2');
});

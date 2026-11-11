// Zeilen-Grammatik des Referenz-Slots (cards/reference-rows.js): Verweise und
// «in Abschnitten» je Objektart, Kappung, Kontext-Regel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capRefs, ctxRow, rowRefs, rowPageIds, REF_ROW_CAP } from '../../public/js/cards/reference-rows.js';

test('capRefs: kappt auf REF_ROW_CAP und zählt den Rest', () => {
  const list = Array.from({ length: REF_ROW_CAP + 3 }, (_, i) => i);
  const { shown, more } = capRefs(list);
  assert.equal(shown.length, REF_ROW_CAP);
  assert.equal(more, 3);
  assert.deepEqual(capRefs(null), { shown: [], more: 0 });
});

test('rowRefs: Figur → Kapitelauftritte', () => {
  assert.deepEqual(rowRefs('figur', { kapitel: [{ chapter_id: 3, name: 'Eins' }, null] }),
    [{ type: 'kapitel', id: 3, name: 'Eins' }]);
});

test('rowRefs: Ort → Kapitel + Figuren', () => {
  assert.deepEqual(rowRefs('ort', { kapitel: [{ chapter_id: 1, name: 'A' }], figuren: ['f1', ''] }), [
    { type: 'kapitel', id: 1, name: 'A' },
    { type: 'figur', id: 'f1' },
  ]);
});

test('rowRefs: Szene → Kapitel, Figuren, Orte (in dieser Reihenfolge)', () => {
  assert.deepEqual(rowRefs('szene', { chapter_id: 2, kapitel: 'K', fig_ids: ['f'], ort_ids: [7] }), [
    { type: 'kapitel', id: 2, name: 'K' },
    { type: 'figur', id: 'f' },
    { type: 'ort', id: 7 },
  ]);
  assert.deepEqual(rowRefs('szene', {}), []);
});

test('rowRefs: Ereignis → Kapitel (Name ↔ ID-Paare) + Figuren', () => {
  assert.deepEqual(rowRefs('ereignis', {
    kapitel: ['A', 'B'], chapter_ids: [1, null], figuren: [{ id: 'f', name: 'Fritz' }],
  }), [
    { type: 'kapitel', id: 1, name: 'A' },
    { type: 'kapitel', id: undefined, name: 'B' },
    { type: 'figur', id: 'f', name: 'Fritz' },
  ]);
});

test('rowPageIds: Buch-Scope zeigt jeden verankerten Abschnitt', () => {
  assert.deepEqual(rowPageIds('szene', { page_id: 5 }), [5]);
  assert.deepEqual(rowPageIds('ereignis', { page_ids: [1, 2, 2, null] }), [1, 2]);
  assert.deepEqual(rowPageIds('beat', { occ_top: [{ page_id: 4 }, { page_id: 4 }, {}] }), [4]);
  assert.deepEqual(rowPageIds('recherche', {
    links: [{ target_kind: 'page', target_id: 9 }, { target_kind: 'chapter', target_id: 1 }],
  }), [9]);
  assert.deepEqual(rowPageIds('figur', { kapitel: [{ chapter_id: 1 }] }), []);
});

test('rowPageIds: Kontext-Scope zeigt nur ANDERE Abschnitte', () => {
  const ctx = { contextActive: true, pageId: 1 };
  assert.deepEqual(rowPageIds('ereignis', { refCtx: 'page', page_ids: [1, 2] }, ctx), []);
  assert.deepEqual(rowPageIds('ereignis', { refCtx: 'chapter', page_ids: [1, 2] }, ctx), [2]);
  // Vorberechnete refPageIds des Kontext-Filters haben Vorrang.
  assert.deepEqual(rowPageIds('szene', { refCtx: 'chapter', page_id: 1, refPageIds: [3] }, ctx), [3]);
});

test('ctxRow: stabile Kopie je Quell-Array und Kontext, nie Mutation', () => {
  const a = { id: 1, name: 'Anna' };
  const all = [a];
  const p1 = ctxRow(all, a, 'page');
  assert.deepEqual(p1, { id: 1, name: 'Anna', refCtx: 'page' });
  assert.equal(a.refCtx, undefined, 'Quelle bleibt unberührt');
  assert.equal(ctxRow(all, a, 'page'), p1, 'Neuberechnung liefert dasselbe Objekt');
  assert.notEqual(ctxRow(all, a, 'chapter'), p1, 'anderer Kontext, andere Kopie');
  assert.notEqual(ctxRow([a], a, 'page'), p1, 'neues Quell-Array (Katalog neu geladen) → neue Kopie');
  assert.deepEqual(ctxRow(null, a, 'page'), p1, 'ohne Quelle: ungecachte Kopie');
});

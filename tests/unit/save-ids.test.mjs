// Unit-Tests für public/js/repo/save-ids.js — Save-Kennungen zählen nur auf
// der Basis, gegen die ihr PUT ging.
//
// Kette nach verlorener Antwort: alle PUTs laufen gegen denselben Stempel (der
// Editor rückt ohne Antwort nicht vor) → Vorgänger gehen als `own_save_ids` mit.
// Ein Stand auf einer anderen Basis (Konflikt-Auflösung gegen einen älteren
// Stand, veraltete Ansicht) ist kein Nachfahre → keine Kennungen, Merge-Pfad.

import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { beginSave, confirmSave, dropSave, isOwnServerSave, ownSaveIds } = await import('../../public/js/repo/save-ids.js');

const B0 = '2026-10-18T09:27:00.000Z';
const B1 = '2026-10-18T09:29:00.000Z';
const OLD = '2026-10-16T14:25:37.842Z';

test('Kette nach verlorener Antwort: Vorgänger auf derselben Basis gehen mit', () => {
  const a = beginSave('notebook', 1, [], B0);
  assert.deepEqual(a.own_save_ids, []);
  const b = beginSave('notebook', 1, [], B0);
  assert.deepEqual(b.own_save_ids, [a.save_id]);
  assert.equal(isOwnServerSave('notebook', 1, a.save_id, [B0]), true);
});

test('Andere Basis: Kennung geht nicht mit und zählt nicht als eigen', () => {
  const a = beginSave('notebook', 2, [], B1);
  // Konflikt-Auflösung gegen einen älteren Stand desselben Tabs.
  const r = beginSave('notebook', 2, [], OLD);
  assert.deepEqual(r.own_save_ids, [], 'kein own_save_ids → Server antwortet 409, Merge');
  assert.equal(isOwnServerSave('notebook', 2, a.save_id, [OLD]), false);
  assert.equal(isOwnServerSave('notebook', 2, a.save_id, [OLD, B1]), true, 'passt eine der lokalen Basen, zählt sie');
  assert.equal(isOwnServerSave('notebook', 2, a.save_id, []), false, 'ohne lokale Basis nie eigen');
});

test('Save ohne Basis wird nicht vermerkt', () => {
  const a = beginSave('notebook', 3, [], null);
  assert.ok(a.save_id);
  assert.deepEqual(ownSaveIds('notebook', 3), []);
  assert.equal(isOwnServerSave('notebook', 3, a.save_id, [null]), false);
});

test('confirmSave räumt bis einschliesslich der bestätigten Kennung, dropSave nur sie', () => {
  const a = beginSave('book', 4, [], B0);
  const b = beginSave('book', 4, [], B0);
  const c = beginSave('book', 4, [], B0);
  dropSave('book', 4, c.save_id);
  assert.deepEqual(ownSaveIds('book', 4).map((e) => e.id), [a.save_id, b.save_id]);
  confirmSave('book', 4, a.save_id);
  assert.deepEqual(ownSaveIds('book', 4).map((e) => e.id), [b.save_id]);
});

test('Schreiber sind getrennt: Notebook-Kennung zählt nicht für den Bucheditor', () => {
  const a = beginSave('notebook', 5, [], B0);
  assert.equal(isOwnServerSave('book', 5, a.save_id, [B0]), false);
});

test('Outbox: Draft-Einträge zählen nur auf der Draft-Basis', () => {
  const a = beginSave('notebook', 6, [], B0);
  const draftIds = ownSaveIds('notebook', 6);
  assert.deepEqual(beginSave('outbox', 6, draftIds, B0).own_save_ids, [a.save_id]);
  assert.deepEqual(beginSave('outbox', 6, draftIds, OLD).own_save_ids, []);
  assert.equal(isOwnServerSave('notebook', 6, a.save_id, [B0], draftIds), true);
});

test('Alt-Einträge ohne Basis (blosse Strings) fallen weg', () => {
  store.set('own_save_ids:notebook:7', JSON.stringify(['00000000-0000-4000-8000-000000000001']));
  assert.deepEqual(ownSaveIds('notebook', 7), []);
  assert.equal(isOwnServerSave('notebook', 7, '00000000-0000-4000-8000-000000000001', [B0]), false);
  assert.deepEqual(beginSave('outbox', 7, ['00000000-0000-4000-8000-000000000001'], B0).own_save_ids, []);
});

// Kontinuitäts-Karte: das Suchfeld der Filterleiste (kontinuitaetFilters.suche)
// filtert über Typ, Beschreibung, Empfehlung, Figuren, beide Stellen und Quelle,
// gross/klein egal; leere Suche lässt alles durch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const filters = { figurId: '', kapitelId: '', schwere: '', status: '', suche: '' };
const stores = { nav: { tree: [], pages: [], selectedBookId: 1 }, catalog: { figuren: [] }, catalogUi: { kontinuitaetFilters: filters } };
globalThis.Alpine = { store: (k) => stores[k] };
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.Alpine = globalThis.Alpine;
globalThis.window.__app = { $store: stores, t: (k) => k };

const { kontinuitaetMethods } = await import('../../public/js/book/kontinuitaet.js');

const RESULT = {
  issues: [
    { id: 1, schwere: 'kritisch', beschreibung: 'Augenfarbe wechselt', figuren: ['Anna'], stelle_a: 'Kapitel 1' },
    { id: 2, schwere: 'mittel', beschreibung: 'Datum passt nicht', empfehlung: 'Jahr prüfen', stelle_b: 'Der Brief' },
    { id: 3, schwere: 'niedrig', beschreibung: 'Ort falsch', quelle: 'https://example.org/bern' },
  ],
};

function ids(suche) {
  filters.suche = suche;
  const c = { ...kontinuitaetMethods, _memos: {}, kontinuitaetResult: RESULT };
  return c.kontinuitaetIssuesFiltered().map(i => i.id);
}

test('leere Suche filtert nichts', () => {
  assert.deepEqual(ids(''), [1, 2, 3]);
  assert.deepEqual(ids('   '), [1, 2, 3]);
});

test('Suche trifft Beschreibung, Figuren, Empfehlung, Stellen, Quelle — case-insensitiv', () => {
  assert.deepEqual(ids('AUGEN'), [1]);
  assert.deepEqual(ids('anna'), [1]);
  assert.deepEqual(ids('jahr'), [2]);
  assert.deepEqual(ids('brief'), [2]);
  assert.deepEqual(ids('bern'), [3]);
  assert.deepEqual(ids('nichtvorhanden'), []);
});

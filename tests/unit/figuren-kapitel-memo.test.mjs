// Memo-Abhaengigkeit der Kapitelachse der Figuren-Karte
// (public/js/cards/figuren-card.js#figurenKapitelOptionen).
//
// Das Ergebnis sortiert nach root._chapterIdOrderMap und beschriftet nach
// root._chapterLabelMap (tree/build.js setzt beide bei jedem Tree-Build neu).
// Haengt der Memo nur an `figuren`, bleibt nach einem Kapitel-Umsortieren oder
// -Umbenennen — oder wenn die Figuren vor dem Tree ankommen — die alte Achse in
// Praesenz-Heatmap, Graph-X-Achse und Kapitelfilter stehen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOptions } from '../../public/js/chapter-filter.js';

function setup() {
  let factory = null;
  const figuren = [
    { id: 'fig_1', name: 'A', kapitel: [{ chapter_id: 1, name: 'Eins' }, { chapter_id: 2, name: 'Zwei' }] },
  ];
  const pages = [{ id: 11, name: 'S1', chapter_id: 1 }];
  const stores = {
    catalog: { figuren },
    catalogUi: { figurenFilters: { suche: '', kapitelId: 1, seiteId: '' } },
    nav: { pages },
    shell: { uiLocale: 'de' },
  };
  const root = {
    $store: stores,
    _chapterIdOrderMap: new Map([[1, 0], [2, 1]]),
    _chapterLabelMap: new Map([[1, 'Eins'], [2, 'Zwei']]),
    _pageIdOrderMap: new Map([[11, 0]]),
    _kapitelOptionen(ids) {
      return idOptions(ids, id => this._chapterLabelMap.get(Number(id)), id => this._chapterIdOrderMap.get(Number(id)) ?? 9999);
    },
    _seitenOptionen(ids) {
      return idOptions(ids, id => pages[this._pageIdOrderMap.get(Number(id))]?.name, id => this._pageIdOrderMap.get(Number(id)) ?? 9999);
    },
  };
  globalThis.window = { Alpine: { data: (_n, fn) => { factory = fn; } }, __app: root };
  globalThis.Alpine = { store: (n) => stores[n] };
  return { root, stores, getFactory: () => factory };
}

const labels = (opts) => opts.map(o => o.label);

test('figurenKapitelOptionen folgt einer neuen Kapitelreihenfolge', async () => {
  const { root, getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  assert.deepEqual(card.figurenKapitelOptionen(), [{ value: 1, label: 'Eins' }, { value: 2, label: 'Zwei' }]);
  // Tree-Build nach Umsortieren: neue Map-Referenz, gleiche Figuren.
  root._chapterIdOrderMap = new Map([[1, 1], [2, 0]]);
  assert.deepEqual(labels(card.figurenKapitelOptionen()), ['Zwei', 'Eins']);
});

test('figurenKapitelOptionen folgt einer Umbenennung', async () => {
  const { root, getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  card.figurenKapitelOptionen();
  root._chapterLabelMap = new Map([[1, 'Anfang'], [2, 'Zwei']]);
  assert.deepEqual(labels(card.figurenKapitelOptionen()), ['Anfang', 'Zwei']);
});

test('figurenKapitelOptionen bleibt bei unveraenderten Deps gecacht', async () => {
  const { getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  const a = card.figurenKapitelOptionen();
  assert.equal(card.figurenKapitelOptionen(), a);
});

test('figurenSeitenOptionen haengt an der Abschnitts-Reihenfolge', async () => {
  const { root, stores, getFactory } = setup();
  stores.catalog.figuren[0].seiten = [{ kapitel: 'Eins', seite: 'S1', chapter_id: 1, page_id: 11 }];
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  const a = card.figurenSeitenOptionen();
  assert.deepEqual(a, [{ value: 11, label: 'S1' }]);
  root._pageIdOrderMap = new Map([[11, 0]]);
  assert.notEqual(card.figurenSeitenOptionen(), a);
});

test('veralteter Kapitelfilter (Kapitel ohne Figur) filtert nicht alles weg', async () => {
  const { stores, getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  stores.catalogUi.figurenFilters.kapitelId = 99;
  assert.equal(card.filteredFiguren().length, 1);
  stores.catalogUi.figurenFilters.kapitelId = 'Eins';
  assert.equal(card.filteredFiguren().length, 1, 'altes Namensformat wirkt nicht');
});

// Memo-Abhaengigkeit der Kapitelachse der Figuren-Karte
// (public/js/cards/figuren-card.js#figurenKapitelListe).
//
// Das Ergebnis sortiert nach root._chapterOrderMap (tree/build.js setzt die Map
// bei jedem Tree-Build neu). Haengt der Memo nur an `figuren`, bleibt nach einem
// Kapitel-Umsortieren — oder wenn die Figuren vor dem Tree ankommen — die alte
// Reihenfolge in Praesenz-Heatmap, Graph-X-Achse und Kapitelfilter stehen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function setup() {
  let factory = null;
  const figuren = [
    { id: 'fig_1', name: 'A', kapitel: [{ name: 'Eins' }, { name: 'Zwei' }] },
  ];
  const stores = {
    catalog: { figuren },
    catalogUi: { figurenFilters: { suche: '', kapitel: 'Eins', seite: '' } },
  };
  const root = {
    _chapterOrderMap: new Map([['Eins', 0], ['Zwei', 1]]),
    _pageOrderMap: new Map(),
    _deriveKapitel(items, extract) {
      const names = new Set();
      for (const it of items) for (const k of extract(it) || []) names.add(k.name);
      return [...names].sort((a, b) => this._chapterOrderMap.get(a) - this._chapterOrderMap.get(b));
    },
    _sortByPageOrder(names) { return [...names]; },
  };
  globalThis.window = { Alpine: { data: (_n, fn) => { factory = fn; } }, __app: root };
  globalThis.Alpine = { store: (n) => stores[n] };
  return { root, stores, getFactory: () => factory };
}

test('figurenKapitelListe folgt einer neuen Kapitelreihenfolge', async () => {
  const { root, getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  assert.deepEqual(card.figurenKapitelListe(), ['Eins', 'Zwei']);
  // Tree-Build nach Umsortieren: neue Map-Referenz, gleiche Figuren.
  root._chapterOrderMap = new Map([['Eins', 1], ['Zwei', 0]]);
  assert.deepEqual(card.figurenKapitelListe(), ['Zwei', 'Eins']);
});

test('figurenKapitelListe bleibt bei unveraenderten Deps gecacht', async () => {
  const { getFactory } = setup();
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  const a = card.figurenKapitelListe();
  assert.equal(card.figurenKapitelListe(), a);
});

test('figurenSeitenListe haengt an der Seiten-Reihenfolge', async () => {
  const { root, stores, getFactory } = setup();
  stores.catalog.figuren[0].seiten = [{ kapitel: 'Eins', seite: 'S1' }];
  const { registerFigurenCard } = await import('../../public/js/cards/figuren-card.js');
  registerFigurenCard();
  const card = getFactory()();
  const a = card.figurenSeitenListe();
  root._pageOrderMap = new Map([['S1', 0]]);
  assert.notEqual(card.figurenSeitenListe(), a);
});

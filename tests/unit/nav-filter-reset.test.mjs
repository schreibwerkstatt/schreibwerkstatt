// Sprung auf eine Entitaet raeumt IHRE Listen-Filter weg.
//
// Why: `openXxxById` oeffnet die Karte und scrollt auf die Zeile. Steht in der
// Liste noch ein Filter, der das Ziel ausschneidet, wird die Zeile nie gerendert
// — der Klick sieht fuer den User wie ein Aussetzer aus (Karte offen, geklickte
// Figur fehlt). Genau so gemeldet aus der Alterstabelle: Liste nach „fabio"
// gefiltert, Klick auf „reto" tat nichts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => {};
globalThis.window = globalThis.window || { dispatchEvent: () => {} };

const { appNavigationMethods } = await import('../../public/js/app/app-navigation.js');

function makeCtx() {
  return {
    showFiguresCard: true,
    $store: {
      catalogUi: {
        selectedFigurId: null,
        figurenFilters: { kapitelId: 1, seiteId: 3, suche: 'fabio', typ: 'randfigur', sort: 'name' },
      },
    },
    $nextTick: async () => {},
    _beginNavigation() {},
    _endNavigation() {},
    _openFigurInListe: appNavigationMethods._openFigurInListe,
  };
}

test('openFigurById raeumt alle ausblendenden Figuren-Filter weg, die Sortierung bleibt', async () => {
  const ctx = makeCtx();
  await appNavigationMethods.openFigurById.call(ctx, '7');
  assert.equal(ctx.$store.catalogUi.figurenFilters.suche, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.typ, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.sort, 'name', 'Sortierung blendet nichts aus');
  assert.equal(ctx.$store.catalogUi.figurenFilters.kapitelId, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.seiteId, '');
  assert.equal(ctx.$store.catalogUi.selectedFigurId, 7, 'ID auf Number normalisiert');
});

test('openFigurMitKapitel raeumt die Suche weg, setzt aber das Kapitel', async () => {
  const ctx = makeCtx();
  await appNavigationMethods.openFigurMitKapitel.call(ctx, 7, 9);
  assert.equal(ctx.$store.catalogUi.figurenFilters.suche, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.kapitelId, 9, 'Kapitel per ID, nicht per Name');
  assert.equal(ctx.$store.catalogUi.figurenFilters.seiteId, '');
});

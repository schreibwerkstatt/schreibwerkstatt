// Fehler-Banner und Wiederverwendung in loadBookOverview
// (public/js/book-overview/load.js):
//   * 403 (Betrachter ohne editor-Recht auf Figuren/Szenen/Orte/Songs) ist ein
//     erwarteter Zustand, kein Ladefehler → kein Eintrag in overviewLoadErrors.
//   * Ein neuer Load startet mit leerem Fehlerstand.
//   * Bereits geladener Figuren-/Orte-Katalog des offenen Buchs wird
//     wiederverwendet; `fresh` fragt trotzdem den Server.
//   * Recent fragt mehr an, als es zeigt (gelöschte Abschnitte fallen heraus).
import test from 'node:test';
import assert from 'node:assert/strict';

let fetchCalls = [];
let statusFor = () => 200;
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchCalls.push(u);
  const status = statusFor(u);
  if (status !== 200) {
    return { ok: false, status, clone() { return this; }, json: async () => ({ error_code: 'X' }) };
  }
  return { ok: true, status: 200, json: async () => [] };
};

const catalog = { figuren: [], orte: [], szenen: [] };
globalThis.window = { __app: { pages: [], tree: [] } };
globalThis.Alpine = {
  store: (n) => (n === 'nav' ? globalThis.window.__app : n === 'catalog' ? catalog : {}),
};

const { bookOverviewMethods } = await import('../../public/js/book-overview.js');
const { treeBelongsTo, RECENT_FETCH_LIMIT, RECENT_SHOW_LIMIT } = await import('../../public/js/book-overview/load.js');

function makeCtx() {
  return { overviewLoadErrors: [], _memos: {}, ...bookOverviewMethods };
}

test('403 auf Figuren/Szenen/Orte/Songs → kein Fehler-Banner', async () => {
  fetchCalls = [];
  statusFor = (u) => (/\/figures\/|\/locations\/|\/songs\//.test(u) ? 403 : 200);
  const ctx = makeCtx();
  await ctx.loadBookOverview(7);
  assert.deepEqual(ctx.overviewLoadErrors, []);
  assert.deepEqual(ctx.overviewFiguren, []);
  assert.deepEqual(ctx.overviewSzenen, []);
});

test('echter Fehler (500) landet im Banner', async () => {
  statusFor = (u) => (u.includes('/history/coverage/') ? 500 : 200);
  const ctx = makeCtx();
  await ctx.loadBookOverview(7);
  assert.deepEqual(ctx.overviewLoadErrors, ['coverage']);
});

test('neuer Load verwirft den Fehlerstand des vorigen', async () => {
  const ctx = makeCtx();
  ctx.overviewLoadErrors = ['coverage'];
  statusFor = () => 200;
  let seenDuringLoad = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (seenDuringLoad === null) seenDuringLoad = [...ctx.overviewLoadErrors];
    return origFetch(url);
  };
  await ctx.loadBookOverview(8);
  globalThis.fetch = origFetch;
  assert.deepEqual(seenDuringLoad, [], 'Banner verschwindet mit Beginn des neuen Loads');
  assert.deepEqual(ctx.overviewLoadErrors, []);
});

test('Figuren-/Orte-/Szenen-Katalog des offenen Buchs wird wiederverwendet, fresh holt neu', async () => {
  statusFor = () => 200;
  catalog.figuren = [{ id: 'f1', name: 'Anna', kurzname: 'Anna', rolle: null }];
  catalog.orte = [{ id: 'o1', name: 'Markt', kapitel: [] }];
  catalog.szenen = [{ id: 's1', wertung: 'stark' }, { id: 's2', wertung: 'mittel', stale: true }];
  fetchCalls = [];
  const ctx = makeCtx();
  await ctx.loadBookOverview(9);
  assert.ok(!fetchCalls.some(u => /\/figures\/9$/.test(u)), 'kein /figures-Fetch');
  assert.ok(!fetchCalls.some(u => u.includes('/locations/9')), 'kein /locations-Fetch');
  assert.ok(!fetchCalls.some(u => u.includes('/figures/scenes/9')), 'kein /figures/scenes-Fetch');
  assert.deepEqual(ctx.overviewSzenen.map(s => s.id), ['s1'], 'stale-Szenen auch aus dem Katalog gefiltert');
  assert.deepEqual(ctx.overviewFiguren.map(f => f.id), ['f1']);
  assert.deepEqual(ctx.overviewOrte.map(o => o.id), ['o1']);

  fetchCalls = [];
  await ctx.loadBookOverview(9, { fresh: true });
  assert.ok(fetchCalls.some(u => /\/figures\/9$/.test(u)), 'Refresh fragt den Server');
  assert.ok(fetchCalls.some(u => u.includes('/locations/9')));
  assert.ok(fetchCalls.some(u => u.includes('/figures/scenes/9')));
  catalog.figuren = [];
  catalog.orte = [];
  catalog.szenen = [];
});

test('Recent: Endpunkt mit Puffer, Anzeige gekürzt nach dem Abgleich', async () => {
  fetchCalls = [];
  statusFor = () => 200;
  const ctx = makeCtx();
  await ctx.loadBookOverview(10);
  assert.ok(fetchCalls.some(u => u.includes(`/usage/page/recent?book_id=10&limit=${RECENT_FETCH_LIMIT}`)));
  globalThis.window.__app.pages = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  // Seite 2 existiert nicht mehr — die Liste füllt trotzdem auf RECENT_SHOW_LIMIT auf.
  ctx.overviewRecent = [1, 99, 2, 3, 4, 5, 6, 7].map(page_id => ({ page_id }));
  ctx._memos = {};
  const ids = ctx.overviewRecentPages().map(p => p.id);
  assert.equal(ids.length, RECENT_SHOW_LIMIT);
  assert.deepEqual(ids, [1, 2, 3, 4, 5]);
  globalThis.window.__app.pages = [];
});

test('treeBelongsTo: Baum des vorigen Buchs zählt nicht', () => {
  globalThis.window.__app.pages = [{ id: 1, book_id: 3 }];
  globalThis.window.__app._treeBookId = 3;
  assert.equal(treeBelongsTo(globalThis.window.__app, 4), false);
  assert.equal(treeBelongsTo(globalThis.window.__app, 3), true);
  globalThis.window.__app._treeBookId = null;
  assert.equal(treeBelongsTo(globalThis.window.__app, 4), false, 'Fallback über book_id der Seiten');
  globalThis.window.__app.pages = [];
  assert.equal(treeBelongsTo(globalThis.window.__app, 3), false, 'leerer Baum');
});

test('403 → kein Analyse-CTA (Betrachter könnte nichts tun)', async () => {
  statusFor = (u) => (/\/figures\/|\/locations\//.test(u) ? 403 : 200);
  globalThis.window.__app.pages = [{ id: 1 }];
  const ctx = makeCtx();
  await ctx.loadBookOverview(11);
  assert.deepEqual(ctx.overviewForbidden.sort(), ['figuren', 'orte', 'szenen']);
  assert.equal(ctx.overviewNeedsAnalysis(), false);
  statusFor = () => 200;
  await ctx.loadBookOverview(12);
  assert.equal(ctx.overviewNeedsAnalysis(), true, 'mit Recht und ohne Analyse: CTA');
  globalThis.window.__app.pages = [];
});

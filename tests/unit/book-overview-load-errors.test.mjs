// Fehler-Banner und Wiederverwendung in loadBookOverview
// (public/js/book-overview/load.js) über die gebündelte Antwort GET /overview/:id:
//   * `forbidden` (Betrachter ohne editor-Recht auf Figuren/Szenen/Orte/Songs) ist
//     ein erwarteter Zustand, kein Ladefehler → kein Eintrag in overviewLoadErrors.
//   * `error` eines Banner-Teils landet im Banner, eines stillen Teils nicht.
//   * Ein neuer Load startet mit leerem Fehlerstand.
//   * Bereits geladener Figuren-/Orte-/Szenen-Katalog des offenen Buchs wird per
//     `?skip=` ausgelassen; `fresh` fragt trotzdem den Server.
import test from 'node:test';
import assert from 'node:assert/strict';

let fetchCalls = [];
// Teil-Zustand je Key: 'ok' (Default) | 'forbidden' | 'error'.
let partState = () => 'ok';
let overviewStatus = 200;
globalThis.fetch = async (url) => {
  const u = String(url);
  fetchCalls.push(u);
  if (u.includes('/overview/')) {
    if (overviewStatus !== 200) {
      return { ok: false, status: overviewStatus, clone() { return this; }, json: async () => ({ error_code: 'X' }) };
    }
    const skip = new URL(u, 'http://x').searchParams.get('skip')?.split(',') || [];
    const parts = {};
    for (const key of Object.keys(OVERVIEW_PARTS)) {
      if (skip.includes(key)) continue;
      const st = partState(key);
      parts[key] = st === 'forbidden' ? { forbidden: true } : st === 'error' ? { error: true } : { data: null };
    }
    return { ok: true, status: 200, json: async () => ({ parts }) };
  }
  return { ok: true, status: 200, json: async () => [] };
};

const catalog = { figuren: [], orte: [], szenen: [] };
globalThis.window = { __app: { pages: [], tree: [] } };
globalThis.Alpine = {
  store: (n) => (n === 'nav' ? globalThis.window.__app : n === 'catalog' ? catalog : {}),
};

const { bookOverviewMethods } = await import('../../public/js/book-overview.js');
const { treeBelongsTo, RECENT_SHOW_LIMIT, OVERVIEW_PARTS, readOverviewBundle } = await import('../../public/js/book-overview/load.js');

function makeCtx() {
  return { overviewLoadErrors: [], _memos: {}, ...bookOverviewMethods };
}

test('forbidden auf Figuren/Szenen/Orte/Songs → kein Fehler-Banner', async () => {
  partState = (k) => (['figuren', 'szenen', 'orte', 'songs'].includes(k) ? 'forbidden' : 'ok');
  const ctx = makeCtx();
  await ctx.loadBookOverview(7);
  assert.deepEqual(ctx.overviewLoadErrors, []);
  assert.deepEqual(ctx.overviewFiguren, []);
  assert.deepEqual(ctx.overviewSzenen, []);
  partState = () => 'ok';
});

test('Fehler eines Banner-Teils landet im Banner, eines stillen Teils nicht', async () => {
  partState = (k) => (k === 'coverage' || k === 'plot' ? 'error' : 'ok');
  const ctx = makeCtx();
  await ctx.loadBookOverview(7);
  assert.deepEqual(ctx.overviewLoadErrors, ['coverage']);
  partState = () => 'ok';
});

test('Bündel ganz ausgefallen → ein Banner-Eintrag, Tiles leer', async () => {
  overviewStatus = 500;
  const ctx = makeCtx();
  await ctx.loadBookOverview(7);
  assert.deepEqual(ctx.overviewLoadErrors, ['overview']);
  assert.equal(ctx.overviewCoverage, null);
  overviewStatus = 200;
});

test('readOverviewBundle: Daten, Recht und Fehler je Teil; fehlender Teil ist nichts davon', () => {
  const r = readOverviewBundle({ parts: {
    coverage: { data: { pct: 5 } }, figuren: { forbidden: true }, plot: { forbidden: true },
    heat: { error: true }, motifs: { error: true },
  } });
  assert.deepEqual(r.data, { coverage: { pct: 5 } });
  assert.deepEqual(r.forbidden, ['figuren']);
  assert.deepEqual(r.failed, ['heat']);
});

test('neuer Load verwirft den Fehlerstand des vorigen', async () => {
  const ctx = makeCtx();
  ctx.overviewLoadErrors = ['coverage'];
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
  catalog.figuren = [{ id: 'f1', name: 'Anna', kurzname: 'Anna', rolle: null }];
  catalog.orte = [{ id: 'o1', name: 'Markt', kapitel: [] }];
  catalog.szenen = [{ id: 's1', wertung: 'stark' }, { id: 's2', wertung: 'mittel', stale: true }];
  fetchCalls = [];
  const ctx = makeCtx();
  await ctx.loadBookOverview(9);
  const call = fetchCalls.find(u => u.includes('/overview/9'));
  assert.ok(call.includes('skip=figuren,orte,szenen'), call);
  assert.deepEqual(ctx.overviewSzenen.map(s => s.id), ['s1'], 'stale-Szenen auch aus dem Katalog gefiltert');
  assert.deepEqual(ctx.overviewFiguren.map(f => f.id), ['f1']);
  assert.deepEqual(ctx.overviewOrte.map(o => o.id), ['o1']);

  fetchCalls = [];
  await ctx.loadBookOverview(9, { fresh: true });
  assert.ok(fetchCalls.some(u => u.endsWith('/overview/9')), 'Refresh fragt den Server ohne skip');
  catalog.figuren = [];
  catalog.orte = [];
  catalog.szenen = [];
});

test('Recent: Anzeige gekürzt nach dem Abgleich mit dem Baum', () => {
  const ctx = makeCtx();
  globalThis.window.__app.pages = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  // Seite 99 existiert nicht mehr — die Liste füllt trotzdem auf RECENT_SHOW_LIMIT auf.
  ctx.overviewRecent = [1, 99, 2, 3, 4, 5, 6, 7].map(page_id => ({ page_id }));
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

test('forbidden → kein Analyse-CTA (Betrachter könnte nichts tun)', async () => {
  partState = (k) => (['figuren', 'szenen', 'orte'].includes(k) ? 'forbidden' : 'ok');
  globalThis.window.__app.pages = [{ id: 1 }];
  const ctx = makeCtx();
  await ctx.loadBookOverview(11);
  assert.deepEqual(ctx.overviewForbidden.sort(), ['figuren', 'orte', 'szenen']);
  assert.equal(ctx.overviewNeedsAnalysis(), false);
  partState = () => 'ok';
  await ctx.loadBookOverview(12);
  assert.equal(ctx.overviewNeedsAnalysis(), true, 'mit Recht und ohne Analyse: CTA');
  globalThis.window.__app.pages = [];
});

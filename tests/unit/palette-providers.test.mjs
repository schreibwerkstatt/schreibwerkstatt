// Such-Provider der Command-Palette (public/js/cards/palette-providers.js) und
// der geteilte Treffer-Sprung (search-hit.js): Prefix-Routing, Legende,
// Sprungziele, Nachladen nach Fehler, Volltext-Cache je Palettenöffnung.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, PALETTE_LEGEND, parseQuery, ensureLoaded,
} from '../../public/js/cards/palette-providers.js';
import { buildPaletteSections } from '../../public/js/cards/palette-sections.js';
import { activateSearchHit, crossBookHash } from '../../public/js/cards/search-hit.js';

const nav = { selectedBookId: 1, tree: [], pages: [] };
globalThis.Alpine = { store: () => nav };
const t = (k) => k;
const provider = (key) => PROVIDERS.find(p => p.key === key);

test('parseQuery erkennt jedes Provider-Prefix und den Befehls-Modus', () => {
  assert.deepEqual(parseQuery('  '), { mode: 'all', q: '' });
  assert.deepEqual(parseQuery('> neu'), { mode: 'commands', q: 'neu' });
  for (const p of PROVIDERS) {
    const r = parseQuery(p.prefix + ' foo');
    assert.equal(r.mode, 'provider');
    assert.equal(r.provider, p);
    assert.equal(r.q, 'foo');
  }
  assert.deepEqual(parseQuery('foo'), { mode: 'all', q: 'foo' });
});

test('Legende listet Befehle + jedes Provider-Prefix genau einmal', () => {
  const prefixes = PALETTE_LEGEND.map(r => r.prefix);
  assert.deepEqual(prefixes, ['>', ...PROVIDERS.map(p => p.prefix)]);
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.ok(PALETTE_LEGEND.every(r => r.labelKey.startsWith('palette.legend.')));
});

test('Kapitel-Treffer springen über openChapterById (Ziel jeder Kapitel-Referenz)', () => {
  nav.tree = [{ type: 'chapter', id: 7, name: 'Anfang', pages: [{ id: 1 }] }];
  const [item] = provider('chapters').search({}, 'anf', t);
  const calls = [];
  item.run({ openChapterById: (id) => calls.push(id) });
  assert.deepEqual(calls, [7]);
});

test('Szenen ohne id erscheinen nicht (wären nicht anspringbar)', () => {
  const root = { $store: { catalog: { szenen: [{ titel: 'Ohne Id' }, { id: 3, titel: 'Mit Id' }] } } };
  const items = provider('szenen').search(root, 'id', t);
  assert.deepEqual(items.map(i => i.key), ['szene:3']);
});

test('ensureLoaded: nach einem Fehler lädt der nächste Aufruf erneut, nach Erfolg nicht', async () => {
  nav.selectedBookId = 42;
  const list = [];
  let runs = 0;
  const flush = () => new Promise(r => setTimeout(r, 0));
  ensureLoaded('test-src', () => list, () => { runs++; return Promise.reject(new Error('net')); });
  await flush();
  ensureLoaded('test-src', () => list, () => { runs++; return Promise.resolve(); });
  await flush();
  ensureLoaded('test-src', () => list, () => { runs++; return Promise.resolve(); });
  await flush();
  assert.equal(runs, 2);
  nav.selectedBookId = 1;
});

test('Volltext: Mix-Modus erst ab mixMinLength, cancel leert den Cache', () => {
  const ft = provider('fulltext');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const build = (query) => buildPaletteSections({
      query, ctx: { selectedBookId: 1, pages: [], bookRole: 'owner', buchtyp: 'roman', cloudModelEffective: true, config: {} },
      devMode: false, recentFeatureKeys: [], recentPageIds: [], t, root: {}, providers: [ft],
    });
    build('ab');
    assert.equal(ft.isPending(), false);
    build('abc');
    assert.equal(ft.isPending(), true);
    ft._cache = { key: 'abc|1', items: [{ kind: 'page', entity_id: 5, title: 'X' }] };
    ft._wantKey = '';
    assert.equal(ft.search({}, 'abc', t).length, 1);
    ft.cancel();
    assert.equal(ft.isPending(), false);
    assert.equal(ft._cache.key, '');
  } finally {
    ft.cancel();
    globalThis.fetch = realFetch;
  }
});

test('crossBookHash: nur für Treffer aus einem anderen Buch, Figuren per nav_id', () => {
  assert.equal(crossBookHash({ kind: 'page', book_id: '1', entity_id: 5 }, 1), null);
  assert.equal(crossBookHash({ kind: 'page', book_id: '2', entity_id: 5 }, 1), '#book/2/page/5');
  assert.equal(crossBookHash({ kind: 'figure', book_id: '2', entity_id: 9, nav_id: 'fig_a' }, 1), '#book/2/figur/fig_a');
  assert.equal(crossBookHash({ kind: 'idea', book_id: '2', entity_id: 9 }, 1), null);
});

test('activateSearchHit: Kapitel → openChapterById, Idee → Ideen-Board ohne Zu-Toggle', async () => {
  const calls = [];
  const root = {
    openChapterById: (id) => calls.push(['chapter', id]),
    gotoPageById: (id, o) => calls.push(['page', id, o?.snippet]),
    toggleIdeenBoardCard: () => calls.push(['toggleIdeen']),
    _scrollToCardByKey: (k) => calls.push(['scroll', k]),
    showIdeenBoardCard: false,
  };
  await activateSearchHit(root, { kind: 'chapter', book_id: '1', entity_id: '4' });
  await activateSearchHit(root, { kind: 'page', book_id: '1', entity_id: 8, snippet: 's' });
  await activateSearchHit(root, { kind: 'idea', book_id: '1', entity_id: 3 });
  root.showIdeenBoardCard = true;
  await activateSearchHit(root, { kind: 'idea', book_id: '1', entity_id: 3 });
  assert.deepEqual(calls, [
    ['chapter', '4'], ['page', 8, 's'], ['toggleIdeen'], ['scroll', 'ideenBoard'],
  ]);
});

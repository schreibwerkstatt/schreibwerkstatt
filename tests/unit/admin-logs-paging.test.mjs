// Unit-Tests fuer adminLogsMethods (public/js/admin/admin-logs.js):
//   - Seiten-Slice + Seitenzahl
//   - Live-Zeilen: stabile Keys, gebuendelt neueste oben auf Seite 1
//   - beim Blaettern warten Live-Zeilen als pending, «zur ersten Seite» spielt sie ein
//   - Cap auf die Maximal-Zahl rueckt den Nachlade-Cursor nach
//   - «Weiter» auf der letzten geladenen Seite laedt vom Server nach

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { addEventListener() {} };
const { adminLogsMethods, ADMIN_LOGS_PAGE_SIZE } = await import('../../public/js/admin/admin-logs.js');

function makeCard(n = 0) {
  const card = {
    adminLogsEntries: [],
    adminLogsPending: [],
    adminLogsPage: 0,
    adminLogsExpanded: {},
    adminLogsHasMore: false,
    adminLogsOldestTs: null,
    adminLogsLoading: false,
    adminLogsFilter: { level: '', scope: '', user: '', book: '', q: '' },
    _adminLogsIncoming: [],
    _adminLogsFlushTimer: null,
    _adminLogsSeq: 0,
    ...adminLogsMethods,
  };
  card.adminLogsEntries = card._adminLogsTag(
    Array.from({ length: n }, (_, i) => ({ ts: `t${String(n - i).padStart(5, '0')}`, msg: `m${n - i}` })),
  );
  return card;
}

test('Seiten-Slice und Seitenzahl', () => {
  const card = makeCard(ADMIN_LOGS_PAGE_SIZE * 2 + 5);
  assert.equal(card.adminLogsPageCount(), 3);
  assert.equal(card.adminLogsPageEntries().length, ADMIN_LOGS_PAGE_SIZE);
  card.adminLogsPage = 2;
  assert.equal(card.adminLogsPageEntries().length, 5);
  assert.equal(makeCard(0).adminLogsPageCount(), 1);
});

test('Live-Zeilen landen gebuendelt oben, Keys bleiben stabil', () => {
  const card = makeCard(3);
  const keysBefore = card.adminLogsEntries.map(e => e._k);
  card._adminLogsIncoming.push({ ts: 'z1', msg: 'a' }, { ts: 'z2', msg: 'b' });
  card._adminLogsFlushIncoming();
  assert.deepEqual(card.adminLogsEntries.slice(0, 2).map(e => e.msg), ['b', 'a']);
  assert.deepEqual(card.adminLogsEntries.slice(2).map(e => e._k), keysBefore);
  assert.equal(new Set(card.adminLogsEntries.map(e => e._k)).size, 5);
});

test('beim Blaettern warten Live-Zeilen als pending', () => {
  const card = makeCard(ADMIN_LOGS_PAGE_SIZE + 1);
  card.adminLogsPage = 1;
  const pageBefore = card.adminLogsPageEntries().map(e => e._k);
  card._adminLogsIncoming.push({ ts: 'z1', msg: 'neu' });
  card._adminLogsFlushIncoming();
  assert.equal(card.adminLogsPending.length, 1);
  assert.deepEqual(card.adminLogsPageEntries().map(e => e._k), pageBefore);
  card.adminLogsFirstPage();
  assert.equal(card.adminLogsPage, 0);
  assert.equal(card.adminLogsPending.length, 0);
  assert.equal(card.adminLogsEntries[0].msg, 'neu');
});

test('Cap kuerzt die Liste und rueckt den Cursor nach', () => {
  const card = makeCard(1995);
  card._adminLogsIncoming.push(...Array.from({ length: 20 }, (_, i) => ({ ts: `z${i}`, msg: 'x' })));
  card._adminLogsFlushIncoming();
  assert.equal(card.adminLogsEntries.length, 2000);
  assert.equal(card.adminLogsOldestTs, card.adminLogsEntries[1999].ts);
  assert.equal(card.adminLogsHasMore, true);
});

test('Weiter auf der letzten Seite laedt nach', async () => {
  const card = makeCard(ADMIN_LOGS_PAGE_SIZE);
  card.adminLogsHasMore = true;
  let calls = 0;
  card.adminLogsLoadMore = async function () {
    calls++;
    this.adminLogsEntries = this.adminLogsEntries.concat(this._adminLogsTag([{ ts: 'a0', msg: 'alt' }]));
    this.adminLogsHasMore = false;
  };
  assert.equal(card.adminLogsCanNext(), true);
  await card.adminLogsNextPage();
  assert.equal(calls, 1);
  assert.equal(card.adminLogsPage, 1);
  assert.equal(card.adminLogsCanNext(), false);
  await card.adminLogsNextPage();
  assert.equal(card.adminLogsPage, 1);
});

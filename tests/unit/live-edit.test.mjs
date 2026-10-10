// Live-Edit-Marker (public/js/editor/live-edit.js) + Outbox-Skip.
// Drafts liegen in localStorage und damit in allen Tabs gleich; die Outbox
// eines Tabs darf den Draft nicht pushen, den ein anderer Tab gerade
// bearbeitet — sonst speichert sie mit dessen altem Stempel in seinen Save.
import test from 'node:test';
import assert from 'node:assert/strict';

const map = new Map();
globalThis.localStorage = {
  get length() { return map.size; },
  key(i) { return [...map.keys()][i] ?? null; },
  getItem(k) { return map.has(k) ? map.get(k) : null; },
  setItem(k, v) { map.set(k, String(v)); },
  removeItem(k) { map.delete(k); },
  clear() { map.clear(); },
};
const listeners = new Map();
globalThis.window = globalThis.window || {
  addEventListener(t, f) { listeners.set(t, f); },
  removeEventListener(t) { listeners.delete(t); },
  dispatchEvent() {},
};

const { startLiveEdit, stopLiveEdit, isLiveEditedElsewhere, LIVE_EDIT_STALE_MS } = await import('../../public/js/editor/live-edit.js');
const { getTabId } = await import('../../public/js/tab-id.js');
const { writeDraft } = await import('../../public/js/editor/draft-storage.js');
const { contentRepo } = await import('../../public/js/repo/content.js');
const { appOutboxMethods } = await import('../../public/js/app/app-outbox.js');

const otherTab = (pageId, at = Date.now()) =>
  map.set('notebook_live_edit:' + pageId, JSON.stringify({ tab: 'anderer-tab', at }));

test('eigener Marker zählt nicht als „anderswo"', () => {
  map.clear();
  startLiveEdit(5);
  assert.equal(JSON.parse(map.get('notebook_live_edit:5')).tab, getTabId());
  assert.equal(isLiveEditedElsewhere(5), false);
  stopLiveEdit();
  assert.equal(map.has('notebook_live_edit:5'), false);
});

test('Marker eines anderen Tabs gilt bis STALE_MS, danach nicht mehr', () => {
  map.clear();
  const now = Date.now();
  otherTab(6, now);
  assert.equal(isLiveEditedElsewhere(6, now + 1000), true);
  assert.equal(isLiveEditedElsewhere(6, now + LIVE_EDIT_STALE_MS + 1), false);
});

test('stopLiveEdit räumt keinen Marker ab, den inzwischen ein anderer Tab hält', () => {
  map.clear();
  startLiveEdit(7);
  otherTab(7);
  stopLiveEdit();
  assert.equal(JSON.parse(map.get('notebook_live_edit:7')).tab, 'anderer-tab');
});

test('pagehide gibt den Marker frei, pageshow (Back-Forward-Cache) setzt ihn wieder', () => {
  map.clear();
  startLiveEdit(8);
  listeners.get('pagehide')();
  assert.equal(map.has('notebook_live_edit:8'), false);
  listeners.get('pageshow')();
  assert.equal(JSON.parse(map.get('notebook_live_edit:8')).tab, getTabId());
  stopLiveEdit();
});

function outboxCtx() {
  return Object.assign(Object.create(appOutboxMethods), {
    editMode: false, currentPage: null, conflictResolution: null,
    _pageNameById: () => 'Abschnitt',
  });
}

test('Outbox: Draft eines live bearbeiteten Abschnitts bleibt liegen, kein PUT', async () => {
  map.clear();
  writeDraft(9, '<p>lokal</p>', '<p>basis</p>', '2026-01-01T00:00:00.000Z');
  otherTab(9);
  let puts = 0;
  contentRepo.savePage = async () => { puts++; return {}; };
  assert.equal(await outboxCtx()._flushOneDraft(9), 'skip');
  assert.equal(puts, 0);
});

test('Outbox: ohne fremden Marker wird der Draft gepusht (Weg „outbox")', async () => {
  map.clear();
  writeDraft(10, '<p>lokal</p>', '<p>basis</p>', '2026-01-01T00:00:00.000Z');
  const bodies = [];
  contentRepo.savePage = async (id, body) => { bodies.push(body); return {}; };
  assert.equal(await outboxCtx()._flushOneDraft(10), 'ok');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].save_reason, 'outbox');
});

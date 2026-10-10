// Unit-Tests für den Save-Querschnitt des Notebook-Editors:
//
//   B  Block-IDs im Live-Editor (editor/notebook/block-ids.js): doppelte nach
//      Enter, fehlende bei neuen Blöcken, Übernahme aus der Server-Fassung.
//   A  `_canBackgroundSave`: kein Autosave/Retry unter offenem Konflikt-Modal,
//      auf fremder Seite oder nach einem nicht wiederholbaren Fehler.
//   C  `_releaseDraftAfterSave`: ein Save über einen Seitenwechsel löscht nur
//      den Draft, der dem Gespeicherten entspricht.
//   D  Draft-Flush beim Seitenwechsel (`keepDraft`) und beim Verstecken des Tabs.
//   G  Fehlerklassen (editor/notebook/save-errors.js).
//   I  Outbox pusht keinen Draft ohne Basis-Stempel.
//
// Setup wie notebook-autosave.test.mjs: linkedom als DOM, window.__app als Host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { syncLiveBlockIds, newBid } = await import('../../public/js/editor/notebook/block-ids.js');
const { classifySaveError, isRetryableSaveError } = await import('../../public/js/editor/notebook/save-errors.js');
const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');
const { writeDraft, readDraft } = await import('../../public/js/editor/draft-storage.js');
const { appOutboxMethods } = await import('../../public/js/app/app-outbox.js');

function editor(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}
const bids = (el) => [...el.children].map((c) => c.getAttribute('data-bid'));

function setApp(extra = {}) {
  const app = {
    editMode: true,
    editDirty: true,
    editSaving: false,
    saveOffline: false,
    saveFailKind: null,
    conflictResolution: null,
    currentPage: { id: 5, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    originalHtml: '<p data-bid="aaaaaaaaaaaaaaaa">a</p>',
    lastDraftSavedAt: null,
    t: (k) => k,
    ...extra,
  };
  window.__app = app;
  return app;
}

function mountEditor(html) {
  const host = document.createElement('div');
  host.id = 'editor-card';
  const el = document.createElement('div');
  el.className = 'page-content-view page-content-view--editing';
  el.innerHTML = html;
  host.appendChild(el);
  document.body.appendChild(host);
  return { el, remove: () => document.body.removeChild(host) };
}

// ── B: Block-IDs ─────────────────────────────────────────────────────────────

test('newBid: 16 Hex-Zeichen wie lib/html-clean.js#_newBid', () => {
  assert.match(newBid(), /^[0-9a-f]{16}$/);
  assert.notEqual(newBid(), newBid());
});

test('syncLiveBlockIds: Enter mitten im Absatz → zweite Hälfte bekommt neue ID', () => {
  const ref = '<p data-bid="x1">Beta ganz</p>';
  const el = editor('<p data-bid="x1">Beta</p><p data-bid="x1"> ganz</p>');
  syncLiveBlockIds(el, ref);
  const [a, b] = bids(el);
  assert.equal(a, 'x1', 'erstes Vorkommen behält die ID');
  assert.match(b, /^[0-9a-f]{16}$/);
});

test('syncLiveBlockIds: Enter am Absatzanfang → der Block mit dem Referenztext behält die ID', () => {
  const ref = '<p data-bid="x1">Gamma</p>';
  const el = editor('<p data-bid="x1"><br></p><p data-bid="x1">Gamma</p>');
  syncLiveBlockIds(el, ref);
  const [a, b] = bids(el);
  assert.equal(b, 'x1');
  assert.notEqual(a, 'x1');
});

test('syncLiveBlockIds: fehlende ID → freie Referenz-ID mit gleichem Text, sonst neu', () => {
  const ref = '<p data-bid="r1">eins</p><p data-bid="r2">zwei</p>';
  const el = editor('<p data-bid="r1">eins</p><p>zwei</p><p>drei</p>');
  syncLiveBlockIds(el, ref);
  const [a, b, c] = bids(el);
  assert.equal(a, 'r1');
  assert.equal(b, 'r2', 'aus der Referenz übernommen');
  assert.match(c, /^[0-9a-f]{16}$/);
});

test('syncLiveBlockIds: verschachtelte IDs aus strukturgleichem Referenzblock', () => {
  const ref = '<blockquote data-bid="q1"><p data-bid="q2">Zitat</p></blockquote>';
  const el = editor('<blockquote data-bid="q1"><p>Zitat</p></blockquote>');
  syncLiveBlockIds(el, ref);
  assert.equal(el.querySelector('blockquote p').getAttribute('data-bid'), 'q2');
});

test('syncLiveBlockIds: Referenz ohne IDs (Altseite, leere Seite) → nichts anfassen', () => {
  const el = editor('<p>a</p><p>b</p>');
  assert.equal(syncLiveBlockIds(el, '<p>a</p><p>b</p>'), 0);
  assert.deepEqual(bids(el), [null, null]);
});

test('syncLiveBlockIds: eindeutige IDs → keine Änderung', () => {
  const ref = '<p data-bid="r1">eins</p><p data-bid="r2">zwei</p>';
  const el = editor(ref);
  assert.equal(syncLiveBlockIds(el, ref), 0);
});

// ── G: Fehlerklassen ─────────────────────────────────────────────────────────

test('classifySaveError + isRetryableSaveError', () => {
  assert.equal(classifySaveError(new TypeError('Failed to fetch')), 'network');
  assert.equal(classifySaveError({ status: 423 }), 'locked');
  assert.equal(classifySaveError({ status: 403 }), 'forbidden');
  assert.equal(classifySaveError({ status: 404 }), 'notFound');
  assert.equal(classifySaveError({ status: 401 }), 'auth');
  assert.equal(classifySaveError({ status: 503 }), 'server');
  assert.equal(classifySaveError({ status: 429 }), 'server');
  assert.equal(classifySaveError({ status: 400 }), 'rejected');
  for (const k of [null, 'network', 'server', 'auth', 'conflict']) assert.equal(isRetryableSaveError(k), true, k);
  for (const k of ['locked', 'forbidden', 'notFound', 'rejected']) assert.equal(isRetryableSaveError(k), false, k);
});

test('_noteSaveFailure: 423 nennt den Sperrenden, setzt Klasse + Offline-Flag', () => {
  const app = setApp({ t: (k, p) => `${k}|${p?.user || ''}`, userDisplayName: (e) => (e === 'ann@x' ? 'Ann' : null) });
  const ctx = { ...notebookEditMethods };
  const msg = ctx._noteSaveFailure({ status: 423, body: { locked_by_email: 'ann@x' } });
  assert.equal(msg, 'edit.saveError.lockedBy|Ann');
  assert.equal(app.saveFailKind, 'locked');
  assert.equal(app.saveOffline, true);
});

// ── A: Hintergrund-Saves ─────────────────────────────────────────────────────

test('_fireAutosave/_canBackgroundSave: Modal offen, fremde Seite, Sperrfehler → kein Save', () => {
  const app = setApp();
  let qs = 0;
  const ctx = { ...notebookEditMethods, quickSave() { qs++; } };
  ctx._fireAutosave(5);
  assert.equal(qs, 1, 'Normalfall speichert');

  app.conflictResolution = { pageId: 5 };
  ctx._fireAutosave(5);
  assert.equal(qs, 1, 'offenes Konflikt-Modal → kein Hintergrund-Save');
  app.conflictResolution = null;

  ctx._fireAutosave(6);
  assert.equal(qs, 1, 'für eine andere Seite geplant → kein Save');

  app.saveFailKind = 'locked';
  ctx._fireAutosave(5);
  assert.equal(qs, 1, 'gesperrt → kein automatischer Versuch');
  app.saveFailKind = 'server';
  ctx._fireAutosave(5);
  assert.equal(qs, 2, '5xx → Versuch erlaubt');
});

test('Online-Retry: kein Retry unter offenem Modal und nach 403', () => {
  const app = setApp({ saveOffline: true });
  let qs = 0;
  const ctx = { ...notebookEditMethods, quickSave() { qs++; } };
  ctx._installOnlineRetry();
  try {
    app.conflictResolution = { pageId: 5 };
    app._onlineHandler();
    assert.equal(qs, 0);
    app.conflictResolution = null;
    app.saveFailKind = 'forbidden';
    app._onlineHandler();
    assert.equal(qs, 0);
    app.saveFailKind = 'network';
    app._onlineHandler();
    assert.equal(qs, 1);
  } finally {
    ctx._uninstallOnlineRetry();
  }
});

test('quickSave: offenes Konflikt-Modal → kein Draft-Write, kein PUT', async () => {
  store.clear();
  setApp({ conflictResolution: { pageId: 5 }, canEdit: () => true });
  const ed = mountEditor('<p data-bid="aaaaaaaaaaaaaaaa">a neu</p>');
  try {
    await notebookEditMethods.quickSave.call({ ...notebookEditMethods });
    assert.equal(readDraft(5), null);
  } finally {
    ed.remove();
  }
});

// ── C: Save über einen Seitenwechsel ─────────────────────────────────────────

test('_releaseDraftAfterSave: Draft = Gespeichertes → gelöscht', () => {
  store.clear();
  setApp();
  writeDraft(7, '<p>gespeichert</p>', '<p>alt</p>', 't0');
  notebookEditMethods._releaseDraftAfterSave(7, '<p>gespeichert</p>', { html: '<p>gespeichert</p>', updated_at: 't1' });
  assert.equal(readDraft(7), null);
});

test('_releaseDraftAfterSave: neuerer Draft bleibt, Basis rückt auf den Save vor', () => {
  store.clear();
  setApp();
  writeDraft(7, '<p>gespeichert und weiter</p>', '<p>alt</p>', 't0');
  notebookEditMethods._releaseDraftAfterSave(7, '<p>gespeichert</p>', { html: '<p data-bid="s1">gespeichert</p>', updated_at: 't1' });
  const d = readDraft(7);
  assert.equal(d.html, '<p>gespeichert und weiter</p>');
  assert.equal(d.originalHtml, '<p data-bid="s1">gespeichert</p>');
  assert.equal(d.originalUpdatedAt, 't1');
});

// ── D: Draft-Flush ───────────────────────────────────────────────────────────

test('_teardownEditSession({ keepDraft }): offener Draft-Debounce wird vor dem Abbau eingelöst', () => {
  store.clear();
  setApp({ originalHtml: '<p data-bid="aaaaaaaaaaaaaaaa">a</p>' });
  const ed = mountEditor('<p data-bid="aaaaaaaaaaaaaaaa">a frisch getippt</p>');
  try {
    const ctx = { ...notebookEditMethods, _uninstallFormatMarks() {} };
    ctx._scheduleDraftSave();
    assert.equal(readDraft(5), null, 'Debounce noch offen');
    ctx._teardownEditSession({ keepDraft: true });
    assert.equal(readDraft(5)?.html, '<p data-bid="aaaaaaaaaaaaaaaa">a frisch getippt</p>');
  } finally {
    ed.remove();
  }
});

test('Tab versteckt / pagehide → Draft sofort geschrieben, Listener mit der Session abgebaut', () => {
  store.clear();
  const app = setApp();
  const ed = mountEditor('<p data-bid="aaaaaaaaaaaaaaaa">a versteckt</p>');
  const ctx = { ...notebookEditMethods };
  try {
    ctx._installOnlineRetry();
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(readDraft(5)?.html, '<p data-bid="aaaaaaaaaaaaaaaa">a versteckt</p>');
    ctx._uninstallOnlineRetry();
    assert.equal(app._hideFlushHandler, null);
    assert.equal(app._hideFlushVisHandler, null);
  } finally {
    ed.remove();
  }
});

// ── I: Outbox ────────────────────────────────────────────────────────────────

test('Outbox: Draft ohne Basis-Stempel wird nicht gepusht', async () => {
  store.clear();
  writeDraft(9, '<p>alt</p>', '', null);
  let puts = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { puts++; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const root = { ...appOutboxMethods, editMode: false, currentPage: null, conflictResolution: null, $store: { nav: { pages: [{ id: 9, name: 'S' }] } } };
    assert.equal(await root._flushOneDraft(9), 'skip');
    assert.equal(puts, 0, 'kein PUT ohne OCC-Stempel');
    assert.ok(readDraft(9), 'Draft bleibt für den pendingDraft-Banner liegen');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

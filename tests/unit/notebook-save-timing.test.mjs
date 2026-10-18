// Notebook-Saves bei wackligem Netz (editor/notebook/save-timing.js):
//
//   R  Zeitgesteuerter neuer Versuch nach Netz-/Serverfehler, mit Backoff;
//      keiner nach auth/rejected; ein gelungener Save bzw. das Session-Ende
//      räumt ab und setzt das Backoff zurück.
//   T  Der Notebook-PUT bricht nach PAGE_SAVE_TIMEOUT_MS ab (statt des
//      90-s-Repo-Defaults) und meldet das als Netzfehler.
//   E  Der vorgemerkte Fokus-Exit überdauert einen Save, der bis zum Timeout
//      hängt (Vorabprüfung + PUT).
//
// Setup wie notebook-save-guard.test.mjs: linkedom als DOM, window.__app als Host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

const mem = () => {
  const s = new Map();
  return {
    get length() { return s.size; },
    key: (i) => [...s.keys()][i] ?? null,
    getItem: (k) => (s.has(k) ? s.get(k) : null),
    setItem: (k, v) => { s.set(k, String(v)); },
    removeItem: (k) => { s.delete(k); },
    clear: () => s.clear(),
  };
};
globalThis.localStorage = mem();
globalThis.sessionStorage = mem();

const { PAGE_SAVE_TIMEOUT_MS, SAVE_RETRY_BASE_MS, SAVE_RETRY_MAX_MS, saveRetryDelay, wantsTimedRetry } =
  await import('../../public/js/editor/notebook/save-timing.js');
const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');
const { savePage } = await import('../../public/js/editor/notebook/edit/_shared.js');
const { isNetworkError } = await import('../../public/js/utils/net.js');
const { EXIT_DEFER_MAX_MS } = await import('../../public/js/editor/focus/constants.js');

function setApp(extra = {}) {
  const app = {
    editMode: true,
    editDirty: true,
    editSaving: false,
    saveOffline: false,
    saveFailKind: null,
    conflictResolution: null,
    currentPage: { id: 5, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    t: (k) => k,
    ...extra,
  };
  window.__app = app;
  return app;
}

function card() {
  const calls = [];
  const c = { ...notebookEditMethods, quickSave(reason) { calls.push(reason); } };
  return { c, calls };
}

const netErr = () => Object.assign(new TypeError('Failed to fetch'), {});

// ── R: Backoff-Rechnung ──────────────────────────────────────────────────────

test('saveRetryDelay verdoppelt ab der Basis und deckelt', () => {
  assert.equal(saveRetryDelay(0), SAVE_RETRY_BASE_MS);
  assert.equal(saveRetryDelay(1), SAVE_RETRY_BASE_MS * 2);
  assert.equal(saveRetryDelay(2), SAVE_RETRY_BASE_MS * 4);
  assert.equal(saveRetryDelay(50), SAVE_RETRY_MAX_MS);
  assert.equal(saveRetryDelay(-3), SAVE_RETRY_BASE_MS);
});

test('wantsTimedRetry: nur Netz und Server', () => {
  assert.equal(wantsTimedRetry('network'), true);
  assert.equal(wantsTimedRetry('server'), true);
  for (const k of ['auth', 'conflict', 'rejected', 'locked', 'forbidden', 'notFound', null]) {
    assert.equal(wantsTimedRetry(k), false, k);
  }
});

// ── R: Timer am Save-Fehler ──────────────────────────────────────────────────

test('Netzfehler plant einen neuen Versuch, der quickSave("retry") ruft — mit Backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = setApp();
  const { c, calls } = card();

  c._noteSaveFailure(netErr());
  assert.equal(app.saveFailKind, 'network');
  t.mock.timers.tick(SAVE_RETRY_BASE_MS - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['retry']);

  // Zweiter Fehlversuch: doppelte Wartezeit.
  c._noteSaveFailure(netErr());
  t.mock.timers.tick(SAVE_RETRY_BASE_MS);
  assert.deepEqual(calls, ['retry']);
  t.mock.timers.tick(SAVE_RETRY_BASE_MS);
  assert.deepEqual(calls, ['retry', 'retry']);
  c._clearSaveRetry();
});

test('5xx plant ebenfalls, 4xx und 401 nicht', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setApp();
  const { c, calls } = card();
  c._noteSaveFailure({ status: 503 });
  t.mock.timers.tick(SAVE_RETRY_BASE_MS);
  assert.deepEqual(calls, ['retry']);
  c._clearSaveRetry();

  for (const status of [400, 401, 403]) {
    setApp();
    const k = card();
    k.c._noteSaveFailure({ status });
    t.mock.timers.tick(SAVE_RETRY_MAX_MS);
    assert.deepEqual(k.calls, [], String(status));
  }
});

test('ein späterer nicht wiederholbarer Fehler hebt den geplanten Versuch auf', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setApp();
  const { c, calls } = card();
  c._noteSaveFailure(netErr());
  c._noteSaveFailure({ status: 403 });
  t.mock.timers.tick(SAVE_RETRY_MAX_MS);
  assert.deepEqual(calls, []);
});

test('kein Versuch, wenn beim Feuern ein Save läuft, die Session weg ist oder die Seite gewechselt hat', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const change of [
    (app) => { app.editSaving = true; },
    (app) => { app.editMode = false; },
    (app) => { app.currentPage = { id: 9, updated_at: 'x' }; },
    (app) => { app.editDirty = false; },
  ]) {
    const app = setApp();
    const { c, calls } = card();
    c._noteSaveFailure(netErr());
    change(app);
    t.mock.timers.tick(SAVE_RETRY_BASE_MS);
    assert.deepEqual(calls, []);
    c._clearSaveRetry();
  }
});

test('_clearSaveRetry (Save gelungen / Session-Ende) räumt ab und setzt das Backoff zurück', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = setApp();
  const { c, calls } = card();
  c._noteSaveFailure(netErr());
  c._noteSaveFailure(netErr());
  c._clearSaveRetry();
  assert.equal(app._saveRetryAttempt, 0);
  t.mock.timers.tick(SAVE_RETRY_MAX_MS);
  assert.deepEqual(calls, []);

  // Nach dem Zurücksetzen beginnt das Backoff wieder bei der Basis.
  c._noteSaveFailure(netErr());
  t.mock.timers.tick(SAVE_RETRY_BASE_MS);
  assert.deepEqual(calls, ['retry']);
  c._clearSaveRetry();
});

test('_stopAutosave (Teardown) räumt den geplanten Versuch mit ab', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setApp();
  const { c, calls } = card();
  c._noteSaveFailure(netErr());
  c._stopAutosave();
  t.mock.timers.tick(SAVE_RETRY_MAX_MS);
  assert.deepEqual(calls, []);
});

// ── T: Write-Timeout des Notebook-PUT ────────────────────────────────────────

test('Notebook-PUT bricht nach PAGE_SAVE_TIMEOUT_MS ab und meldet einen Netzfehler', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (_url, opts) => new Promise((_res, rej) => {
    sent++;
    opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
  });
  try {
    const p = savePage(5, { html: '<p>x</p>', pageName: 'S', source: 'focus', expectedUpdatedAt: '2026-01-01T00:00:00Z' });
    let err = null;
    p.catch((e) => { err = e; });
    for (let i = 0; i < 20 && !sent && !err; i++) await new Promise((r) => setImmediate(r));
    assert.equal(err, null, String(err?.stack));
    assert.equal(sent, 1);
    t.mock.timers.tick(PAGE_SAVE_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(err, null, 'vor dem Timeout noch offen');
    t.mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.ok(err, 'nach dem Timeout abgebrochen');
    assert.equal(err.name, 'TimeoutError');
    assert.equal(isNetworkError(err), true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('PAGE_SAVE_TIMEOUT_MS liegt deutlich unter dem 90-s-Repo-Default', () => {
  assert.ok(PAGE_SAVE_TIMEOUT_MS <= 30000);
});

// ── E: Fokus-Exit-Deckel ─────────────────────────────────────────────────────

test('vorgemerkter Fokus-Exit überdauert Vorabprüfung + PUT bis zum Timeout', () => {
  // Vorabprüfung (GET, Repo-Timeout 30 s) + PUT (PAGE_SAVE_TIMEOUT_MS).
  assert.ok(EXIT_DEFER_MAX_MS > 30000 + PAGE_SAVE_TIMEOUT_MS,
    `EXIT_DEFER_MAX_MS=${EXIT_DEFER_MAX_MS} muss einen hängenden Save überdauern`);
});

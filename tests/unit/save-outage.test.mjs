// Save-Ausfall im Notebook-Editor:
//
//   O  save-outage.js sammelt Fehlversuche je Abschnitt und meldet sie beim
//      ersten gelungenen Save als eine Zeile (kind 'save').
//   K  Konfliktpfade setzen die Fehlerklasse 'conflict' — die Statuszeile sagt
//      dann «Konflikt», nicht «Offline»; Netzfehler bei stehendem Netz heissen
//      «Server nicht erreichbar».
//   S  Jeder Draft-Write frischt den Reload-Snapshot auf (TTL ab letzter
//      Eingabe, nicht ab startEdit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML, DOMParser } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = DOMParser;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

function memStorage() {
  const m = new Map();
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
globalThis.localStorage = memStorage();
const session = memStorage();
globalThis.sessionStorage = session;

let onLine = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ onLine }) });

const reports = [];
window.__reportClientError = (p) => reports.push(p);

const { noteSaveOutage, noteSaveRecovered, noteEditStartDuringOutage, formatOutage, _readOutage } =
  await import('../../public/js/editor/notebook/save-outage.js');
const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');
const { appUiMethods } = await import('../../public/js/app/app-ui.js');
const { readNormalSnapshot, clearNormalSnapshot } = await import('../../public/js/editor/notebook/storage.js');

test('O: Fehlversuche sammeln, beim Erfolg eine Zeile melden und schliessen', () => {
  reports.length = 0;
  const t0 = 1_000_000;
  noteSaveOutage(9, { kind: 'network' }, t0);
  noteSaveOutage(9, { kind: 'network' }, t0 + 90_000);
  noteEditStartDuringOutage(9);
  noteSaveOutage(9, { kind: 'conflict', status: 409, reason: 'retry' }, t0 + 420_000);
  const rec = _readOutage(9);
  assert.equal(rec.count, 3);
  assert.deepEqual(rec.kinds, { network: 2, conflict: 1 });
  assert.equal(rec.reloads, 1);

  noteSaveRecovered(9, t0 + 430_000);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, 'save');
  assert.match(reports[0].message, /Abschnitt 9: 3 Fehlversuch\(e\) über 430s \(network×2, conflict×1\)/);
  assert.match(reports[0].message, /letzter conflict 409 via retry/);
  assert.match(reports[0].message, /Reloads=1/);
  assert.equal(_readOutage(9), null, 'Datensatz geschlossen');

  noteSaveRecovered(9, t0 + 500_000);
  assert.equal(reports.length, 1, 'ohne offenen Ausfall keine Meldung');
});

test('O: veralteter Ausfall wird verworfen, nicht gemeldet', () => {
  reports.length = 0;
  noteSaveOutage(10, { kind: 'server', status: 502 }, 0);
  noteSaveRecovered(10, 7 * 60 * 60 * 1000);
  assert.equal(reports.length, 0);
  assert.equal(_readOutage(10), null);
});

test('O: formatOutage nennt online-Zustand zu Beginn und zuletzt', () => {
  const msg = formatOutage(3, { since: 0, count: 1, kinds: { network: 1 }, reloads: 0, lastKind: 'network', lastStatus: null, onlineAtStart: true, onlineAtLast: false }, 5000);
  assert.equal(msg, 'Save-Ausfall Abschnitt 3: 1 Fehlversuch(e) über 5s (network×1) · letzter network · online=true/false');
});

function hostApp(extra = {}) {
  const app = {
    editMode: true, editDirty: true, editSaving: false,
    saveOffline: false, saveFailKind: null, draftPersistFailed: false,
    conflictResolution: null, editConflict: null,
    currentPage: { id: 21, name: 'S', updated_at: '2026-01-01T00:00:00Z' },
    originalHtml: '<p>alt</p>', lastDraftSavedAt: null, lastAutosaveAt: null,
    focusActive: false,
    t: (k) => k, setStatus() {},
    ...extra,
  };
  window.__app = app;
  globalThis.__app = app;
  return app;
}

test('K: _keepAsDraft setzt Klasse conflict und sammelt den Ausfall', () => {
  const app = hostApp();
  notebookEditMethods._keepAsDraft.call(notebookEditMethods, { pageId: 21, html: '<p>neu</p>', statusKey: null });
  assert.equal(app.saveOffline, true);
  assert.equal(app.saveFailKind, 'conflict');
  assert.equal(_readOutage(21).kinds.conflict, 1);
});

test('K: Netzfehler nach dem Konflikt überschreibt die Klasse', () => {
  const app = hostApp({ saveFailKind: 'conflict', saveOffline: true });
  notebookEditMethods._noteSaveFailure.call(notebookEditMethods, new TypeError('Failed to fetch'));
  assert.equal(app.saveFailKind, 'network');
});

function indicator(app) {
  const ctx = { ...appUiMethods, ...app };
  return appUiMethods.saveIndicatorText.call(ctx);
}

test('K: Statuszeile — Konflikt, Server nicht erreichbar, wirklich offline', () => {
  const base = { editSaving: false, saveOffline: true, draftPersistFailed: false, lastDraftSavedAt: null, lastAutosaveAt: null, focusActive: false, currentPage: null, t: (k) => k };
  onLine = true;
  assert.equal(indicator({ ...base, saveFailKind: 'conflict' }), 'edit.status.conflict');
  assert.equal(indicator({ ...base, saveFailKind: 'network' }), 'edit.status.unreachable');
  assert.equal(indicator({ ...base, saveFailKind: 'server' }), 'edit.status.unreachable');
  onLine = false;
  assert.equal(indicator({ ...base, saveFailKind: 'network' }), 'edit.status.offline');
  onLine = true;
  assert.equal(indicator({ ...base, saveFailKind: 'locked' }), 'edit.status.failed');
});

test('S: Draft-Write frischt den Reload-Snapshot auf', () => {
  clearNormalSnapshot();
  hostApp();
  const el = document.createElement('div');
  el.innerHTML = '<p>neuer Text</p>';
  const ctx = { ...notebookEditMethods, _getEditEl: () => el, _ensureLiveBlockIds: () => 0 };
  ctx._flushDraftSaveNow();
  const snap = readNormalSnapshot();
  assert.equal(snap?.pageId, 21);
  assert.ok(Date.now() - snap.ts < 1000);
});

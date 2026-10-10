// Unit-Tests für die Reload-Wiederaufnahme des Notebook-Editors
// (public/js/editor/notebook/card.js#_tryRestoreNotebook). Nach F5/OIDC-Redirect
// mountet der Editor nur dann automatisch, wenn (a) die richtige Seite geladen
// ist UND (b) ein abweichender lokaler Draft existiert — sonst würde der User aus
// „viewing" ungewollt in den Edit-Modus gezwungen.
//
// Setup: sessionStorage/localStorage als In-Memory-Stubs; window.__app als Host;
// linkedom liefert den DOMParser für den Draft-Vergleich.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}
globalThis.sessionStorage = memStore();
globalThis.localStorage = memStore();
globalThis.window = globalThis;
// Draft-Vergleich läuft über isNoChange → normalizeForCompare (DOMParser).
globalThis.DOMParser = DOMParser;

const { notebookCardMethods } = await import('../../public/js/editor/notebook/card.js');
const { writeDraft } = await import('../../public/js/editor/notebook/../draft-storage.js');

function ctxWith(snapshot) {
  return { ...notebookCardMethods, _notebookRestoreSnapshot: snapshot };
}

function setApp(extra = {}) {
  const app = {
    editMode: false,
    focusActive: false,
    showEditorCard: true,
    currentPage: { id: 5 },
    originalHtml: '<p>server</p>',
    renderedPageHtml: '<p>server</p>',
    _started: 0,
    startEdit() { this._started++; },
    ...extra,
  };
  globalThis.__app = app;
  return app;
}

test('_tryRestoreNotebook: abweichender Draft → startEdit + Snapshot konsumiert', () => {
  localStorage.clear();
  writeDraft(5, '<p>lokaler entwurf</p>', '<p>server</p>', null);
  const app = setApp();
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 1, 'startEdit ausgelöst');
  assert.equal(ctx._notebookRestoreSnapshot, null, 'Snapshot einmalig konsumiert');
});

test('_tryRestoreNotebook: kein Draft → kein startEdit (User bleibt im View)', () => {
  localStorage.clear();
  const app = setApp();
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0, 'ohne Draft kein Edit-Zwang');
  assert.equal(ctx._notebookRestoreSnapshot, null, 'Snapshot dennoch konsumiert (kein Retry-Loop)');
});

test('_tryRestoreNotebook: Draft = Server-Stand → kein startEdit', () => {
  localStorage.clear();
  writeDraft(5, '<p>server</p>', '<p>server</p>', null);
  const app = setApp();
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0, 'gleicher Inhalt ist kein „unsaved" → kein Edit');
});

test('_tryRestoreNotebook: Draft = Server-Stand, Leseansicht dekoriert → kein startEdit', () => {
  // renderedPageHtml trägt Marken der Leseansicht; verglichen wird mit der
  // Server-Fassung (originalHtml), sonst zwänge jeder Reload in den Edit-Modus.
  localStorage.clear();
  writeDraft(5, '<p>server</p>', '<p>server</p>', null);
  const app = setApp({ renderedPageHtml: '<p><span class="figure-mark">server</span></p>' });
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0, 'Dekoration der Leseansicht ist keine Änderung');
  assert.equal(ctx._notebookRestoreSnapshot, null, 'Snapshot konsumiert');
});

test('_tryRestoreNotebook: falsche Seite → No-op, Snapshot bleibt (wartet auf richtige Seite)', () => {
  localStorage.clear();
  writeDraft(5, '<p>x</p>', '<p>server</p>', null);
  const app = setApp({ currentPage: { id: 99 } });
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0);
  assert.deepEqual(ctx._notebookRestoreSnapshot, { pageId: 5 }, 'Snapshot NICHT verworfen (Seite noch nicht geladen)');
});

test('_tryRestoreNotebook: bereits im Edit-/Focus-Modus → No-op', () => {
  localStorage.clear();
  writeDraft(5, '<p>x</p>', '<p>server</p>', null);
  const app = setApp({ editMode: true });
  const ctx = ctxWith({ pageId: 5 });
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0);
});

test('_tryRestoreNotebook: ohne Snapshot → No-op', () => {
  const app = setApp();
  const ctx = ctxWith(null);
  ctx._tryRestoreNotebook();
  assert.equal(app._started, 0);
});

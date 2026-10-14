// Unit-Tests für public/js/editor/shortcuts.js#handleNavHotkey — die
// Navigations-Chords der App-Schale (⌘E Edit-Toggle, ⌘P Baumsuche, ⌘K Palette,
// ⌘⇧Leertaste Diktat, ⌘⇧F Volltextsuche).
//
// Leitmotiv der Tests: ein Chord, den die App für sich beansprucht, darf NIE an
// den Browser durchfallen. Chrome belegt genau diese Tasten selbst — ⌘E = „Auswahl
// mit dem Standardsuchanbieter suchen", ⌘P = Drucken — und ein undiagnostiziertes
// Durchfallen zeigt sich beim User als „⌘E öffnet plötzlich eine Suchmaschine im
// Tab" bzw. als Druck-Dialog, nicht als Fehler in der App. Deshalb wird
// `prevented` auch in den Zuständen geprüft, in denen die Aktion gar nicht
// ausführbar ist (keine Seite offen, kein Baumfilter im DOM).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;

// linkedom kann CustomEvent nicht dispatchen (eventPhase ist nur lesbar) und
// lässt sich am window-Proxy kein dispatchEvent setzen. Für die Event-Pfade der
// App (Palette öffnen) tauschen wir das Fenster deshalb für die Dauer des
// Aufrufs gegen einen Recorder.
const dispatched = [];
function withDispatchRecorder(fn) {
  const prev = globalThis.window;
  globalThis.window = { dispatchEvent: (e) => { dispatched.push(e?.type); return true; } };
  try { return fn(); } finally { globalThis.window = prev; }
}

const { shortcutsMethods } = await import('../../public/js/editor/shortcuts.js');

function ev({ key = 'e', code, metaKey = true, ctrlKey = false, altKey = false, shiftKey = false } = {}) {
  return {
    key, code: code ?? `Key${key.toUpperCase()}`,
    metaKey, ctrlKey, altKey, shiftKey,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

function app(over = {}) {
  return {
    currentPage: { id: 7 },
    editMode: false,
    focusActive: false,
    showBookEditorCard: false,
    startEditCalls: 0,
    saveCalls: 0,
    treeSearchCalls: 0,
    dictationCalls: 0,
    statuses: [],
    startEdit() { this.startEditCalls++; },
    quickSave() { this.saveCalls++; },
    focusTreeSearch() { this.treeSearchCalls++; return true; },
    toggleSttDictation() { this.dictationCalls++; },
    setStatus(msg, spinner, duration) { this.statuses.push({ msg, spinner, duration }); },
    t(key, params) {
      const known = { 'shortcuts.editNeedsPage': 'Kein Abschnitt geöffnet — {chord} …' };
      const msg = known[key] ?? key;
      return params ? msg.replace(/\{(\w+)\}/g, (_, k) => params[k]) : msg;
    },
    $store: { shell: { isMac: true }, nav: { selectedBookId: 1 }, stt: { enabled: false } },
    _openSearchFocused() {},
    ...over,
  };
}

const fire = (a, e) => { shortcutsMethods.handleNavHotkey.call(a, e); return e; };

// ────────── ⌘E: Notebook-Edit-Toggle ──────────

test('⌘E mit offener Seite öffnet den Notebook-Editor und isst den Chord', () => {
  const a = app();
  const e = fire(a, ev({ key: 'e' }));
  assert.equal(a.startEditCalls, 1);
  assert.equal(a.saveCalls, 0);
  assert.equal(e.prevented, true, '⌘E gehört der App — darf nicht an den Browser');
});

test('⌘E im Edit-Modus speichert statt neu zu öffnen', () => {
  const a = app({ editMode: true });
  const e = fire(a, ev({ key: 'e' }));
  assert.equal(a.saveCalls, 1);
  assert.equal(a.startEditCalls, 0);
  assert.equal(e.prevented, true);
});

test('⌘E ohne offene Seite: Chord trotzdem gegessen, statt an den Browser zu fallen', () => {
  const a = app({ currentPage: null });
  const e = fire(a, ev({ key: 'e' }));
  assert.equal(e.prevented, true, 'das ist der Bug: ohne currentPage fiel ⌘E an Chrome durch');
  assert.equal(a.startEditCalls, 0);
  assert.equal(a.saveCalls, 0);
});

test('⌘E greift auch auf Windows/Linux mit Strg', () => {
  const a = app();
  const e = fire(a, ev({ key: 'e', metaKey: false, ctrlKey: true }));
  assert.equal(a.startEditCalls, 1);
  assert.equal(e.prevented, true);
});

test('⌘⇧E bleibt unangetastet — der Focus-Toggle-Chord gehört handleFocusHotkey', () => {
  const a = app();
  const e = fire(a, ev({ key: 'E', shiftKey: true }));
  assert.equal(e.prevented, false);
  assert.equal(a.startEditCalls, 0);
  assert.equal(a.saveCalls, 0);
});

test('⌥⌘E bleibt unangetastet (Fremd-Chord, nicht der der App)', () => {
  const e = fire(app(), ev({ key: 'e', altKey: true }));
  assert.equal(e.prevented, false);
});

// ────────── ⌘P: Abschnittsbaum-Suche ──────────

test('⌘P fokussiert den Baumfilter und isst den Chord', () => {
  const a = app();
  const e = fire(a, ev({ key: 'p' }));
  assert.equal(a.treeSearchCalls, 1);
  assert.equal(e.prevented, true);
});

test('⌘P ohne Baumfilter im DOM: kein Druck-Dialog des Browsers', () => {
  const a = app({ focusTreeSearch() { this.treeSearchCalls++; return false; } });
  const e = fire(a, ev({ key: 'p' }));
  assert.equal(a.treeSearchCalls, 1);
  assert.equal(e.prevented, true);
});

// ────────── ⌘K / ⌘⇧F / ⌘⇧Leertaste ──────────

test('⌘K öffnet die Palette und isst den Chord', () => {
  const a = app();
  dispatched.length = 0;
  const e = withDispatchRecorder(() => fire(a, ev({ key: 'k' })));
  assert.equal(e.prevented, true);
  assert.deepEqual(dispatched, ['palette:open']);
});

test('⌘⇧F öffnet die Volltextsuche ausserhalb der Editoren', () => {
  const a = app();
  const e = fire(a, ev({ key: 'F', shiftKey: true }));
  assert.equal(e.prevented, true);
});

test('⌘⇧F im Bucheditor: Karte bleibt unangetastet (der Editor würde mitten im Schreiben zuklappen)', () => {
  const a = app({ showBookEditorCard: true });
  const e = fire(a, ev({ key: 'F', shiftKey: true }));
  assert.equal(e.prevented, false);
});

test('⌘⇧Leertaste ohne Diktat-Freigabe: System-Diktation darf durchkommen', () => {
  const a = app({ editMode: false });
  const e = fire(a, ev({ key: ' ', code: 'Space', shiftKey: true }));
  assert.equal(e.prevented, false);
  assert.equal(a.dictationCalls, 0);
});

test('⌘⇧Leertaste im Edit-Modus mit aktivem STT startet das Diktat', () => {
  const a = app({ editMode: true, $store: { shell: { isMac: true }, stt: { enabled: true } } });
  const e = fire(a, ev({ key: ' ', code: 'Space', shiftKey: true }));
  assert.equal(a.dictationCalls, 1);
  assert.equal(e.prevented, true);
});

// ────────── Nicht-Chords ──────────

test('Taste ohne Modifier bleibt unangetastet', () => {
  const a = app();
  const e = fire(a, ev({ key: 'e', metaKey: false, ctrlKey: false }));
  assert.equal(e.prevented, false);
  assert.equal(a.startEditCalls, 0);
});

test('⌘X (unbekannter Chord) bleibt unangetastet — kein Blind-Durchschlucken', () => {
  const e = fire(app(), ev({ key: 'x' }));
  assert.equal(e.prevented, false);
});
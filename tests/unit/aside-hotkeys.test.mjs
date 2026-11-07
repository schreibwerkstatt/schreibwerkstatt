// Tastaturweg in die Leiste neben dem Notebook-Editor
// ([public/js/editor/aside-hotkeys.js](../../public/js/editor/aside-hotkeys.js)):
// Markierung → Zitat im Eingabefeld von Abschnitts-Chat bzw. Ideen.
import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteIntoDraft, asideHotkeyMethods } from '../../public/js/editor/aside-hotkeys.js';

const q = (s) => `„${s}“`;

test('leeres Feld: Zitat plus Zeilenumbruch, Caret danach', () => {
  assert.equal(quoteIntoDraft('', 'Sie ging.', q), '„Sie ging.“\n');
});

test('Absatzgrenzen und Mehrfach-Leerraum werden zu einer Zeile', () => {
  assert.equal(quoteIntoDraft('', '  Erster Satz.\n\nZweiter\tSatz. ', q), '„Erster Satz. Zweiter Satz.“\n');
});

test('angefangener Entwurf bleibt vor dem Zitat stehen', () => {
  assert.equal(quoteIntoDraft('Passt das?  \n', 'Sie ging.', q), 'Passt das?\n\n„Sie ging.“\n');
});

test('leere Markierung lässt den Entwurf unverändert', () => {
  assert.equal(quoteIntoDraft('Entwurf', '   ', q), 'Entwurf');
  assert.equal(quoteIntoDraft(undefined, '', q), '');
});

test('Kürzel greift nur mit ⌘/Strg+Shift auf der physischen Ziffer 1/2', () => {
  const calls = [];
  const root = {
    ...asideHotkeyMethods,
    canOpenPageAside: () => true,
    openPageAsideFromKeyboard(slot) { calls.push(slot); },
  };
  const ev = (o) => ({ preventDefault() { this.prevented = true; }, ...o });
  // DE/CH-Layout: Shift+1 liefert «+», US «!» — entscheidend ist event.code.
  const e1 = ev({ ctrlKey: true, shiftKey: true, code: 'Digit1', key: '+' });
  root.handleAsideHotkey(e1);
  const e2 = ev({ metaKey: true, shiftKey: true, code: 'Digit2', key: '"' });
  root.handleAsideHotkey(e2);
  root.handleAsideHotkey(ev({ ctrlKey: true, code: 'Digit1', key: '1' }));                 // ohne Shift: Browser-Tab
  root.handleAsideHotkey(ev({ ctrlKey: true, shiftKey: true, altKey: true, code: 'Digit1' })); // AltGr
  root.handleAsideHotkey(ev({ ctrlKey: true, shiftKey: true, code: 'Digit3' }));
  assert.deepEqual(calls, ['chat', 'ideen']);
  assert.ok(e1.prevented && e2.prevented);
});

test('Kürzel ohne offene Leiste-Berechtigung fällt durch', () => {
  let called = false;
  const root = {
    ...asideHotkeyMethods,
    canOpenPageAside: () => false,
    openPageAsideFromKeyboard() { called = true; },
  };
  const e = { ctrlKey: true, shiftKey: true, code: 'Digit1', preventDefault() { this.prevented = true; } };
  root.handleAsideHotkey(e);
  assert.equal(called, false);
  assert.ok(!e.prevented);
});

test('canOpenPageAside: nur Notebook mit offenem Abschnitt, Chat zusätzlich mit Rolle und Inhalt', () => {
  const base = { ...asideHotkeyMethods, showEditorCard: true, currentPage: { id: 1 }, focusActive: false,
    canReview: () => true, currentPageEmpty: false };
  assert.equal(base.canOpenPageAside('chat'), true);
  assert.equal(base.canOpenPageAside('ideen'), true);
  assert.equal({ ...base, focusActive: true }.canOpenPageAside('ideen'), false);
  assert.equal({ ...base, currentPage: null }.canOpenPageAside('ideen'), false);
  assert.equal({ ...base, showEditorCard: false }.canOpenPageAside('chat'), false);
  assert.equal({ ...base, currentPageEmpty: true }.canOpenPageAside('chat'), false);
  assert.equal({ ...base, currentPageEmpty: true }.canOpenPageAside('ideen'), true);
  assert.equal({ ...base, canReview: () => false }.canOpenPageAside('chat'), false);
});

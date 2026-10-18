// Unit-Tests für public/js/editor/shared/edit-history.js — der geteilte
// Undo/Redo-Kern beider Editoren (Notebook-Karte + Standalone-Fokusmodus).
//
// Framework-frei getestet: nur linkedom-DOM, kein Alpine, kein Host. Die
// Karten-/Schalen-Glue liegt in notebook-history.test.mjs bzw. den Standalone-
// E2E-Specs.
// Fixtures setzen `innerHTML` mit statischen Literalen aus dem Test-Source —
// keine externen Daten, kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="ed" contenteditable="true"></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { createEditHistory, captureCaretOffset, restoreCaretAtOffset, changedCaretOffset, mapCaretOffset } =
  await import('../../public/js/editor/shared/edit-history.js');

// mountHtml bewusst als schlichtes innerHTML — der Kern darf keine Pipeline
// voraussetzen (genau das ist der Grund für die Injektion).
function makeHistory(opts = {}) {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>start</p>';
  const inputs = [];
  el.addEventListener('input', (e) => inputs.push(e.inputType ?? null));
  const restored = [];
  const history = createEditHistory({
    getRoot: () => el,
    mountHtml: (node, html) => { node.innerHTML = html; },
    onRestored: (node, snap) => restored.push(snap.html),
    debounceMs: 5,
    ...opts,
  });
  history.reset(el.innerHTML);
  return { history, el, inputs, restored };
}

const setHtml = (el, html) => { el.innerHTML = html; };

test('reset legt Baseline: idx=0, weder undo noch redo möglich', () => {
  const { history } = makeHistory();
  assert.equal(history.size(), 1);
  assert.equal(history.index(), 0);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
});

test('fehlende Callbacks sind ein Konstruktionsfehler, kein stiller No-op', () => {
  assert.throws(() => createEditHistory({}), /getRoot/);
  assert.throws(() => createEditHistory({ getRoot: () => null }), /mountHtml/);
});

test('pushNow dedupt gegen die Spitze', () => {
  const { history } = makeHistory();
  history.pushNow();
  assert.equal(history.size(), 1, 'unveränderter innerHTML erzeugt keinen zweiten Eintrag');
});

test('pushNow schiebt neue Variante + bewegt den Index', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  assert.equal(history.size(), 2);
  assert.equal(history.index(), 1);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
});

test('undo/redo laufen die Kette hin und zurück', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  assert.equal(history.undo(), true);
  assert.equal(el.innerHTML, '<p>start</p>');
  assert.equal(history.canRedo(), true);
  assert.equal(history.redo(), true);
  assert.equal(el.innerHTML, '<p>v2</p>');
  assert.equal(history.canRedo(), false);
});

test('undo/redo melden false an den Enden statt zu klemmen', () => {
  const { history, el } = makeHistory();
  assert.equal(history.undo(), false, 'Baseline ist die Untergrenze');
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  assert.equal(history.redo(), false, 'an der Spitze gibt es kein Redo');
});

test('Restore feuert InputEvent mit inputType historyUndo/historyRedo (Client-Vertrag)', () => {
  const { history, el, inputs } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  history.undo();
  history.redo();
  assert.deepEqual(inputs, ['historyUndo', 'historyRedo']);
});

test('onRestored läuft pro Restore mit dem wiederhergestellten Stand', () => {
  const { history, el, restored } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  history.undo();
  assert.deepEqual(restored, ['<p>start</p>']);
});

test('ein wütender onRestored kippt das Restore nicht', () => {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>start</p>';
  const history = createEditHistory({
    getRoot: () => el,
    mountHtml: (node, html) => { node.innerHTML = html; },
    onRestored: () => { throw new Error('boom'); },
  });
  history.reset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  assert.equal(history.undo(), true);
  assert.equal(el.innerHTML, '<p>start</p>');
  assert.equal(history.isApplying(), false, 'finally hat das Flag zurückgesetzt');
});

test('während des Restores wird nicht gepusht (sonst stirbt Redo sofort)', () => {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>start</p>';
  let history;
  // Simuliert den echten Pfad: das vom Restore gefeuerte `input` löst beim
  // Aufrufer einen Push aus (SPA: @input="_markEditDirty()", Standalone:
  // eigener input-Listener).
  el.addEventListener('input', () => history?.pushSoon());
  history = createEditHistory({
    getRoot: () => el,
    mountHtml: (node, html) => { node.innerHTML = html; },
    debounceMs: 5,
  });
  history.reset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  history.undo();
  assert.equal(history.canRedo(), true, 'Redo lebt noch');
  assert.equal(history.size(), 2, 'kein zusätzlicher Eintrag aus dem Restore-input');
});

test('neuer Push schneidet den Redo-Ast ab', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  setHtml(el, '<p>v3</p>');
  history.pushNow();
  history.undo();
  history.undo();
  setHtml(el, '<p>abzweig</p>');
  history.pushNow();
  assert.equal(history.size(), 2, 'Redo-Tail gedroppt, neue Spitze');
  assert.equal(history.canRedo(), false);
});

test('Deckel greift: älteste Einträge fallen raus', () => {
  const { history, el } = makeHistory({ max: 10 });
  for (let i = 1; i <= 25; i++) { setHtml(el, `<p>v${i}</p>`); history.pushNow(); }
  assert.equal(history.size(), 10);
  assert.equal(history.index(), 9);
  history.undo();
  assert.equal(el.innerHTML, '<p>v24</p>', 'die Spitze bleibt die jüngste Strecke');
});

test('pushSoon entprellt eine Tipp-Serie zu EINEM Schritt', async () => {
  const { history, el } = makeHistory({ debounceMs: 20 });
  setHtml(el, '<p>a</p>');   history.pushSoon();
  setHtml(el, '<p>ab</p>');  history.pushSoon();
  setHtml(el, '<p>abc</p>'); history.pushSoon();
  assert.equal(history.size(), 1, 'vor Ablauf des Debounce noch nichts geschoben');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(history.size(), 2, 'drei Tastenanschläge = ein Snapshot');
  history.undo();
  assert.equal(el.innerHTML, '<p>start</p>');
});

test('undo löst einen offenen Debounce ein statt ihn zu verlieren', () => {
  const { history, el } = makeHistory({ debounceMs: 10_000 });
  setHtml(el, '<p>gerade getippt</p>');
  history.pushSoon();            // Timer läuft noch
  assert.equal(history.undo(), true);
  assert.equal(el.innerHTML, '<p>start</p>', 'die getippte Strecke wurde zurückgenommen');
  assert.equal(history.canRedo(), true, 'und ist per Redo wieder erreichbar');
});

test('clear verwirft alles, reset legt eine neue Baseline (Historie pro Seite)', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>v2</p>');
  history.pushNow();
  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.index(), -1);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  history.reset('<p>seite2</p>');
  assert.equal(history.size(), 1);
  assert.equal(history.canUndo(), false);
});

test('clear stoppt einen laufenden Debounce (kein Push nach dem Unmount)', async () => {
  const { history, el } = makeHistory({ debounceMs: 10 });
  setHtml(el, '<p>v2</p>');
  history.pushSoon();
  history.clear();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(history.size(), 0, 'der Timer hat nach dem Clear nichts mehr geschoben');
});

test('ohne Container passiert nichts (Editor gerade zu)', () => {
  const history = createEditHistory({
    getRoot: () => null,
    mountHtml: () => { throw new Error('darf nicht mounten'); },
  });
  history.reset('<p>x</p>');
  history.pushNow();
  assert.equal(history.size(), 1);
  assert.doesNotThrow(() => history.undo());
});

// Caret-Offsets selbst sind hier NICHT testbar: linkedoms `createRange()`
// liefert kein `setStart`, weshalb `restoreCaretAtOffset` seinen Guard zieht und
// zum No-op wird. Genau deshalb steht der Caret-Beweis im echten Browser —
// tests/e2e/focus-undo.webkit.spec.js („Caret sitzt nach dem Undo …").
// Hier bleibt nur die Robustheits-Zusage: nichts davon darf werfen.
test('Caret-Helfer sind in einer Umgebung ohne Range-API still (kein Crash)', () => {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>kurz</p>';
  assert.doesNotThrow(() => restoreCaretAtOffset(el, 2));
  assert.doesNotThrow(() => restoreCaretAtOffset(el, 999));
  assert.doesNotThrow(() => restoreCaretAtOffset(null, 1));
  assert.doesNotThrow(() => captureCaretOffset(null));
});

test('onChange meldet jede Änderung an canUndo/canRedo (reaktive Buttons)', async () => {
  let n = 0;
  const { history, el } = makeHistory({ onChange: () => { n++; } });
  const afterReset = n;
  assert.ok(afterReset >= 1, 'reset meldet');
  setHtml(el, '<p>start x</p>');
  history.pushSoon();
  assert.ok(n > afterReset, 'Debounce-Start meldet (Undo wird schon jetzt möglich)');
  const beforeFire = n;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(n > beforeFire, 'Push nach Ablauf des Debounce meldet');
  const beforeUndo = n;
  history.undo();
  assert.ok(n > beforeUndo, 'undo meldet');
  const beforeRedo = n;
  history.redo();
  assert.ok(n > beforeRedo, 'redo meldet');
  const beforeClear = n;
  history.clear();
  assert.ok(n > beforeClear, 'clear meldet');
});

test('canUndo ist schon während des offenen Debounce true, canRedo dann false', () => {
  const { history, el } = makeHistory({ debounceMs: 10000 });
  setHtml(el, '<p>start a</p>');
  history.pushNow();
  history.undo();
  assert.equal(history.canRedo(), true);
  setHtml(el, '<p>start b</p>');
  history.pushSoon();
  assert.equal(history.canUndo(), true, 'offene Tipp-Strecke ist rückgängig machbar');
  assert.equal(history.canRedo(), false, 'Einlösen schneidet den Redo-Ast ab');
  history.clear();
});

test('redo im offenen Debounce verwirft die frische Eingabe nicht', () => {
  const { history, el } = makeHistory({ debounceMs: 10000 });
  setHtml(el, '<p>start a</p>');
  history.pushNow();
  history.undo();
  setHtml(el, '<p>start X</p>');
  history.pushSoon();
  assert.equal(history.redo(), false, 'Redo-Ast ist durch die Eingabe abgeschnitten');
  assert.equal(el.innerHTML, '<p>start X</p>', 'die gerade getippte Strecke bleibt stehen');
  history.undo();
  assert.equal(el.innerHTML, '<p>start</p>');
  history.redo();
  assert.equal(el.innerHTML, '<p>start X</p>', 'und ist per Redo wieder herstellbar');
});

test('changedCaretOffset: Caret ans Ende des geänderten Bereichs im neuen Text', () => {
  // Undo einer Eingabe am Ende: Caret an die Einfügestelle, nicht an den Anfang.
  assert.equal(changedCaretOffset('Absatz eins zwei', 'Absatz eins', 0), 11);
  // Redo derselben Eingabe: hinter das wiederhergestellte Stück.
  assert.equal(changedCaretOffset('Absatz eins', 'Absatz eins zwei', 0), 16);
  // Mitte: Einfügung zwischen gleichem Präfix und Suffix.
  assert.equal(changedCaretOffset('ab XY cd', 'ab cd', 0), 3);
  // Wiederholte Zeichen an der Grenze: Suffix darf das Präfix nicht überlappen.
  assert.equal(changedCaretOffset('aaa', 'aa', 0), 2);
  // Unveränderter Text (reine Formatierung): gemerkter Offset.
  assert.equal(changedCaretOffset('gleich', 'gleich', 4), 4);
});

test('reine Block-ID-Änderung ist kein eigener Undo-Schritt', () => {
  // Save/Merge setzen data-bid als Attribut ins Live-DOM (ohne input). Ein
  // danach eingefrorener Vorher-Stand (Paste) wäre sonst ein Schritt, dessen
  // Undo nichts Sichtbares tut.
  const { history, el } = makeHistory();
  setHtml(el, '<p>start</p><p>neu</p>');
  history.pushNow();
  setHtml(el, '<p>start</p><p data-bid="aa11">neu</p>');
  history.pushNow();
  assert.equal(history.size(), 2, 'nur die ID kam dazu → Spitze aufgefrischt');
  setHtml(el, '<p>start</p><p data-bid="aa11">neu eingefügt</p>');
  history.pushNow();
  history.undo();
  assert.equal(el.innerHTML, '<p>start</p><p data-bid="aa11">neu</p>', 'Restore behält die ID');
  history.undo();
  assert.equal(el.innerHTML, '<p>start</p>', 'zweites Undo nimmt die Eingabe zurück');
});

test('undo/redo ohne Container bewegen den Index nicht', () => {
  let root = null;
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>a</p>';
  const history = createEditHistory({ getRoot: () => root, mountHtml: (n, h) => { n.innerHTML = h; } });
  root = el;
  history.reset('<p>a</p>');
  el.innerHTML = '<p>b</p>';
  history.pushNow();
  root = null;
  assert.equal(history.undo(), false);
  assert.equal(history.index(), 1, 'Index steht noch auf dem eingehängten Stand');
  root = el;
  assert.equal(history.undo(), true);
  assert.equal(el.innerHTML, '<p>a</p>');
});

test('rebase: Spitze = jetziger Inhalt, ältere Stände gemappt, Redo-Ast weg', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>start 1</p>');
  history.pushNow();
  setHtml(el, '<p>start 12</p>');
  history.pushNow();
  history.undo();                    // Redo-Ast: «start 12»
  setHtml(el, '<p>start 1</p>');
  history.pushNow();                 // Vertrag: pushNow vor der Umschreibung
  setHtml(el, '<p>start 1</p><p>R</p>');
  history.rebase((h) => h + '<p>R</p>');
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 2);
  history.undo();
  assert.equal(el.innerHTML, '<p>start</p><p>R</p>', 'älterer Stand trägt den Remote-Block');
  history.redo();
  assert.equal(el.innerHTML, '<p>start 1</p><p>R</p>');
});

test('rebase: ab dem ersten nicht übertragbaren Stand fällt alles Ältere weg', () => {
  const { history, el } = makeHistory();
  setHtml(el, '<p>a</p>'); history.pushNow();
  setHtml(el, '<p>b</p>'); history.pushNow();
  setHtml(el, '<p>c</p>'); history.pushNow();
  setHtml(el, '<p>c</p><p>R</p>');
  // «a» nicht übertragbar → «start» davor darf nicht nachrücken (keine Lücke).
  history.rebase((h) => (h === '<p>a</p>' ? null : h + '<p>R</p>'));
  assert.equal(history.size(), 2);
  history.undo();
  assert.equal(el.innerHTML, '<p>b</p><p>R</p>');
  assert.equal(history.canUndo(), false);
});

test('rebase ohne Verlauf legt den jetzigen Inhalt als Baseline', () => {
  const { history, el } = makeHistory();
  history.clear();
  setHtml(el, '<p>x</p>');
  history.rebase(() => { throw new Error('darf nicht laufen'); });
  assert.equal(history.size(), 1);
  assert.equal(history.canUndo(), false);
});

test('mapCaretOffset: Anfang bleibt, Ende wandert um die Längendifferenz, Mitte ans Änderungsende', () => {
  // Remote-Absatz «REMOTE » oben eingefügt: Caret im eigenen Text wandert mit.
  assert.equal(mapCaretOffset('eins zwei', 'REMOTE eins zwei', 6), 13);
  // Einfügung hinter dem Caret: Caret bleibt.
  assert.equal(mapCaretOffset('eins zwei', 'eins zwei REMOTE', 3), 3);
  // Caret mitten im ersetzten Bereich: ans Ende der Ersetzung.
  assert.equal(mapCaretOffset('aXXXb', 'aYYYYYb', 2), 6);
  assert.equal(mapCaretOffset('abc', 'abc', 2), 2);
  assert.equal(mapCaretOffset('abc', 'xabc', null), null);
});

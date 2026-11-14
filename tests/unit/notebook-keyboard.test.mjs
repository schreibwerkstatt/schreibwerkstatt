// Unit-Tests für die Tastatur-/Zwischenablage-Pfade des NOTEBOOK-Editors, soweit
// sie ohne Editing-Default prüfbar sind (linkedom: kein Range-Editing, keine
// Selection-API). Caret-abhängiges Verhalten (Löschen über Blockgrenzen, Enter
// mit Teilung am Caret, Slash am Absatzanfang im echten Browser) prüft
// tests/e2e-app/notebook-keyboard.spec.js gegen die gebootete App.
//
// Hier: listenfeste Zeilen-Merges und Teilung (notebook/line-merge.js), Slash-
// Umwandeln eines Blocks mit Text (toolbar/slash.js#_convertSlashBlock), die
// Diagramm-Ausnahme in BOUNDARY_WRAPPER_SEL, die Kopier-Fassung
// (shared/paste.js#clipboardHtml) und die Tastengriffe des Dispatchers
// (IME-Guard, Datums-Taste nach Position, Cmd+K nur mit Markierung).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;
globalThis.Node = window.Node;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.Alpine = { store: () => ({ uiLocale: 'de' }) };
if (typeof document.getSelection !== 'function') document.getSelection = () => null;

const lm = await import('../../public/js/editor/notebook/line-merge.js');
const { toolbarCardMethods } = await import('../../public/js/editor/notebook/toolbar.js');
const { SLASH_ITEMS, BOUNDARY_WRAPPER_SEL } = await import('../../public/js/editor/notebook/toolbar/_shared.js');
const { clipboardHtml } = await import('../../public/js/editor/shared/paste.js');
const { TODO_LIST_SEL, TODO_TEXT_SEL } = await import('../../public/js/editor/shared/todo-html.js');

window.__app = { focusActive: false, editMode: true, _markEditDirty() {}, t: (k) => k };

function mount(html) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  host.id = 'editor-card';
  const editEl = document.createElement('div');
  editEl.className = 'page-content-view page-content-view--editing';
  editEl.focus = () => {};
  editEl.innerHTML = html;
  host.appendChild(editEl);
  document.body.appendChild(host);
  return editEl;
}

const strip = (s) => s.replace(/\s+data-bid="[^"]*"/g, '');

// ── line-merge.js ────────────────────────────────────────────────────────────

test('deepestLastLine: Listenzeile mit Unterliste → tiefste letzte Zeile', () => {
  const ed = mount('<ul><li>A<ul><li>A1</li><li>A2<ol><li>A2a</li></ol></li></ul></li><li>B</li></ul>');
  const a = ed.querySelector('ul > li');
  assert.equal(lm.deepestLastLine(a).textContent, 'A2a');
  const b = ed.querySelectorAll(':scope > ul > li')[1];
  assert.equal(lm.prevListLine(b).textContent, 'A2a', 'Zeile vor B ist die tiefste letzte Zeile von A');
});

test('prev/nextListLine: über Ebenen hinweg in Leserichtung', () => {
  const ed = mount('<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>');
  const [a, a1, b] = ed.querySelectorAll('li');
  assert.equal(lm.nextListLine(a), a1, 'nach A kommt die erste Unterzeile');
  assert.equal(lm.nextListLine(a1), b, 'nach der letzten Unterzeile kommt B');
  assert.equal(lm.prevListLine(a1), a, 'vor der ersten Unterzeile steht die Elternzeile');
  assert.equal(lm.nextListLine(b), null);
});

test('mergeLines: Text landet VOR der Unterliste des Empfängers, nie dahinter', () => {
  const ed = mount('<ul><li>A<ul><li>A1</li></ul></li></ul>');
  const [a, a1] = ed.querySelectorAll('li');
  lm.mergeLines(a, a1);
  assert.equal(strip(ed.innerHTML), '<ul><li>AA1</li></ul>', 'leere Unterliste räumt sich weg');
});

test('mergeLines: Unterliste der Quelle rückt an ihre Stelle, kein <ul> im <p>', () => {
  const ed = mount('<p>Vor</p><ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>');
  const p = ed.querySelector('p');
  const a = ed.querySelector('ul > li');
  lm.mergeLines(p, a);
  assert.equal(strip(ed.innerHTML), '<p>VorA</p><ul><li>A1</li><li>B</li></ul>');
  assert.equal(ed.querySelector('p ul, p ol'), null);
});

test('mergeLines: Zeile in Unterliste an die tiefste Zeile darüber', () => {
  const ed = mount('<ul><li>A<ul><li>A1</li></ul></li><li>B<ul><li>B1</li></ul></li></ul>');
  const lis = ed.querySelectorAll('li');
  const b = lis[2];
  lm.mergeLines(lm.prevListLine(b), b);
  assert.equal(strip(ed.innerHTML), '<ul><li>A<ul><li>A1B</li></ul></li><li>B1</li></ul>');
});

test('promoteSubLists: Unterzeilen rücken eine Ebene hoch, Reihenfolge bleibt', () => {
  const ed = mount('<ol><li>A<ol><li>A1</li><li>A2</li></ol></li><li>B</li></ol>');
  const a = ed.querySelector('ol > li');
  lm.promoteSubLists(a);
  assert.deepEqual([...ed.querySelectorAll(':scope > ol > li')].map((l) => l.textContent), ['A1', 'A2', 'A', 'B']);
});

test('splitWrapperAtLine: leere Zeile mitten im Gedicht teilt es mit einem Absatz dazwischen', () => {
  const ed = mount('<div class="poem" data-bid="aa"><p>Eins</p><p><br></p><p>Zwei</p></div>');
  const empty = ed.querySelectorAll('p')[1];
  const out = lm.splitWrapperAtLine(empty, empty.parentNode);
  assert.equal(strip(ed.innerHTML), '<div class="poem"><p>Eins</p></div><p><br></p><div class="poem"><p>Zwei</p></div>');
  assert.equal(out.tagName, 'P');
  assert.equal(ed.querySelectorAll('[data-bid="aa"]').length, 1, 'Block-ID nicht dupliziert');
});

test('splitWrapperAtLine: letzte leere Zeile verlässt den Block', () => {
  const ed = mount('<div class="poem"><p>Eins</p><p><br></p></div>');
  const empty = ed.querySelectorAll('p')[1];
  lm.splitWrapperAtLine(empty, empty.parentNode);
  assert.equal(strip(ed.innerHTML), '<div class="poem"><p>Eins</p></div><p><br></p>');
});

test('splitWrapperAtLine: Checkbox-Liste mitten geteilt, beide Hälften sind Checkbox-Listen', () => {
  const ed = mount('<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">A</span></li>'
    + '<li class="todo-item"><input type="checkbox"><span class="todo-text"><br></span></li>'
    + '<li class="todo-item"><input type="checkbox"><span class="todo-text">B</span></li></ul>');
  const empty = ed.querySelectorAll('li')[1];
  lm.splitWrapperAtLine(empty, empty.parentNode);
  const lists = ed.querySelectorAll(TODO_LIST_SEL);
  assert.equal(lists.length, 2);
  assert.equal(lists[0].nextElementSibling.tagName, 'P');
  assert.equal(lists[1].querySelector(TODO_TEXT_SEL).textContent, 'B');
});

test('splitWrapperAtLine keepTail:false (Fokusmodus): Folgezeilen bleiben im Block', () => {
  const ed = mount('<div class="poem"><p>Eins</p><p><br></p><p>Zwei</p></div>');
  const empty = ed.querySelectorAll('p')[1];
  lm.splitWrapperAtLine(empty, empty.parentNode, { keepTail: false });
  assert.equal(strip(ed.innerHTML), '<div class="poem"><p>Eins</p><p>Zwei</p></div><p><br></p>');
});

// ── Diagramm ist nie Wrapper ─────────────────────────────────────────────────

test('BOUNDARY_WRAPPER_SEL: Code-Block ja, Diagramm (pre.mermaid) nein', () => {
  const ed = mount('<pre>code</pre>');
  assert.ok(ed.firstElementChild.matches(BOUNDARY_WRAPPER_SEL));
  ed.firstElementChild.className = 'mermaid';
  assert.equal(ed.firstElementChild.matches(BOUNDARY_WRAPPER_SEL), false);
});

// ── Slash: Querverweis + Umwandeln am Absatzanfang ──────────────────────────

test('SLASH_ITEMS: Querverweis-Eintrag öffnet den Picker', () => {
  const item = SLASH_ITEMS.find((i) => i.key === 'querverweis');
  assert.ok(item && item.xref && item.group === 'insert');
  const ed = mount('<p><br></p>');
  let opened = 0;
  const ctx = { ...toolbarCardMethods, _slashBlock: ed.firstElementChild, slashShow: true, slashQuery: '', openXrefInput() { opened++; } };
  ctx._applySlashItem(item);
  assert.equal(opened, 1);
  assert.equal(ctx.slashShow, false);
});

function convertCtx(block) {
  return { ...toolbarCardMethods, _slashBlock: block, _slashConvert: true, slashShow: true, slashQuery: '', slashIdx: 0, _slashLabels: null, _slashFilterCache: null };
}
const item = (key) => SLASH_ITEMS.find((i) => i.key === key);

test('Slash am Absatzanfang: nur Blocktypen im Menü', () => {
  const ed = mount('<p>Text</p>');
  const ctx = convertCtx(ed.firstElementChild);
  const keys = ctx.slashItems().map((i) => i.key);
  assert.ok(keys.length > 0 && keys.every((k) => item(k).group === 'block'), keys.join(','));
  assert.ok(!keys.includes('bild') && !keys.includes('teilen') && !keys.includes('hr'));
});

test('Slash umwandeln: Absatz → Überschrift behält Inline-Inhalt', () => {
  const ed = mount('<p>Hallo <em>Welt</em></p>');
  convertCtx(ed.firstElementChild)._applySlashItem(item('h2'));
  assert.equal(strip(ed.innerHTML), '<h2>Hallo <em>Welt</em></h2>');
});

test('Slash umwandeln: Absatz → Zitat / Checkbox-Liste / Verlauf über die SSoT', () => {
  let ed = mount('<p>Zeile</p>');
  convertCtx(ed.firstElementChild)._applySlashItem(item('blockquote'));
  assert.equal(strip(ed.innerHTML), '<blockquote><p>Zeile</p></blockquote>');
  ed = mount('<p>Zeile</p>');
  convertCtx(ed.firstElementChild)._applySlashItem(item('todo'));
  assert.equal(ed.querySelector(`${TODO_LIST_SEL} ${TODO_TEXT_SEL}`).textContent, 'Zeile');
  ed = mount('<p>Zeile</p>');
  convertCtx(ed.firstElementChild)._applySlashItem(item('msgthread'));
  assert.ok(ed.querySelector('div.msg-thread > p.msg-in'), 'Verlauf mit Eingangszeile');
});

test('Slash umwandeln: Zitatzeile → Absatz teilt das Zitat an dieser Zeile', () => {
  const ed = mount('<blockquote><p>A</p><p>B</p><p>C</p></blockquote>');
  convertCtx(ed.querySelectorAll('p')[1])._applySlashItem(item('paragraph'));
  assert.equal(strip(ed.innerHTML), '<blockquote><p>A</p></blockquote><p>B</p><blockquote><p>C</p></blockquote>');
});

test('Slash umwandeln: Listenzeile → Absatz verlässt die Liste (Invariante 19)', () => {
  const ed = mount('<ul><li>A</li><li>B</li><li>C</li></ul>');
  convertCtx(ed.querySelectorAll('li')[1])._applySlashItem(item('paragraph'));
  assert.equal(strip(ed.innerHTML), '<ul><li>A</li></ul><p>B</p><ul><li>C</li></ul>');
});

test('Slash umwandeln: Checkbox-Zeile → Absatz nimmt nur den Text, nicht die Checkbox', () => {
  const ed = mount('<ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">Tun</span></li></ul>');
  convertCtx(ed.querySelector('li'))._applySlashItem(item('paragraph'));
  assert.equal(strip(ed.innerHTML), '<p>Tun</p>');
});

test('Slash umwandeln: gleiche Art ist ein No-Op (kein doppelter Block)', () => {
  const ed = mount('<blockquote><p>A</p></blockquote>');
  convertCtx(ed.querySelector('p'))._applySlashItem(item('blockquote'));
  assert.equal(strip(ed.innerHTML), '<blockquote><p>A</p></blockquote>');
});

// ── Kopieren: bereinigte HTML-Fassung ────────────────────────────────────────

test('clipboardHtml: kein style/contenteditable/data-bid, keine Marks, Chip + Querverweis bleiben', () => {
  const html = '<p data-bid="ab12" style="color:red">Er <span class="lektorat-mark">sagte</span> '
    + '<strong>laut</strong> <span class="cite" data-src="7" data-loc="4" contenteditable="false">(M., S. 4)</span> '
    + '<span class="xref" data-xref="chapter" data-xref-id="3" contenteditable="false">Kapitel 3</span>'
    + '<span class="mention-figur">Anna</span></p>';
  const out = clipboardHtml(html);
  assert.ok(!/style=|contenteditable|data-bid|lektorat-mark|mention-figur/.test(out), out);
  assert.match(out, /<strong>laut<\/strong>/);
  assert.match(out, /<span class="cite" data-src="7" data-loc="4">/);
  assert.match(out, /<span class="xref" data-xref="chapter" data-xref-id="3">/);
  assert.match(out, /Anna/, 'Text der entfernten Hülle bleibt');
});

// Lektorat-Vorschlagstext (`.lektorat-ins`) entfernt `stripLektoratMarks` —
// dessen Fragment-Parser greift unter linkedom nicht, das prüft der e2e-Spec.
test('clipboardHtml: gerendertes Diagramm-Bild fällt raus, der Quelltext bleibt', () => {
  const out = clipboardHtml('<pre class="mermaid">graph TD</pre><div class="x"><svg><text>A</text></svg></div>');
  assert.ok(!out.includes('<svg'), out);
  assert.match(out, /graph TD/);
});

// ── Dispatcher-Griffe ────────────────────────────────────────────────────────

function keyEv(props) {
  return { key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
    defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
}

test('IME: Safari-Enter mit keyCode 229 (isComposing false) erreicht keinen Struktur-Handler', () => {
  mount('<p>x</p>');
  let hit = 0;
  const ctx = { ...toolbarCardMethods, slashShow: false, _kbSoftBreak() { hit++; return false; }, _kbTodoEnter() { hit++; return false; } };
  ctx._onEditKeydown(keyEv({ key: 'Enter', keyCode: 229 }));
  assert.equal(hit, 0);
  ctx._onEditKeydown(keyEv({ key: 'Enter', keyCode: 13 }));
  assert.ok(hit > 0, 'ohne Komposition läuft die Kette');
});

test('Datum: physische Taste (code Semicolon) zählt, «;» auf anderer Taste nicht', () => {
  const calls = [];
  document.execCommand = (cmd, _ui, val) => { calls.push([cmd, val]); return true; };
  const ctx = { ...toolbarCardMethods };
  const app = { _markEditDirty() {} };
  assert.equal(ctx._kbDateStamp(keyEv({ key: 'ö', code: 'Semicolon', ctrlKey: true }), app), true, 'DE: Strg+ö');
  assert.equal(ctx._kbDateStamp(keyEv({ key: ';', code: 'Comma', ctrlKey: true, shiftKey: true }), app), false, 'DE: Strg+Shift+, ist kein Datum');
  const [, stamp] = calls[0];
  assert.ok(stamp && !/:/.test(stamp), `ohne Shift nur Datum: ${stamp}`);
  ctx._kbDateStamp(keyEv({ key: ':', code: 'Semicolon', metaKey: true, shiftKey: true }), app);
  assert.match(calls[1][1], /\d{2}:\d{2}/, 'mit Shift Datum + Zeit');
});

test('Cmd+K: mit Markierung im Editor Link, ohne Markierung durchfallen (Palette)', () => {
  const ed = mount('<p>Text</p>');
  const text = ed.querySelector('p').firstChild;
  let links = 0;
  const ctx = { ...toolbarCardMethods, openLinkInput() { links++; } };
  const app = { focusActive: false };
  const fakeSel = (collapsed) => ({ rangeCount: 1, getRangeAt: () => ({ collapsed, commonAncestorContainer: text }) });
  document.getSelection = () => fakeSel(true);
  let e = keyEv({ key: 'k', metaKey: true });
  assert.equal(ctx._kbLink(e, app), false);
  assert.equal(e.defaultPrevented, false, 'Palette darf öffnen');
  document.getSelection = () => fakeSel(false);
  e = keyEv({ key: 'k', ctrlKey: true });
  assert.equal(ctx._kbLink(e, app), true);
  assert.equal(e.defaultPrevented, true, 'Palette setzt aus');
  assert.equal(links, 1);
  assert.equal(ctx._kbLink(keyEv({ key: 'k', metaKey: true }), { focusActive: true }), false, 'Fokusmodus: Palette');
  assert.equal(ctx._kbLink(keyEv({ key: 'K', metaKey: true, shiftKey: true }), app), true, 'Cmd+Shift+K bleibt');
  document.getSelection = () => null;
});

// Notebook-Editor: Panel- und Einfüge-Helfer der Toolbar.
//
//   popover-anchor.js#computePopoverPos  `prefer: 'above'` + `band` (visualViewport)
//                                        für die caret-verankerten Panels
//   caret-panel.js#blockInsertTarget     wohin ein Block aus der Seiten-Toolbar kommt
//   caret-panel.js#placeBlockNode        … und nie in eine Liste (Invariante 19)
//   caret-panel.js#placeCaretInSlotAfter Caret hinter einen eingefügten Block
//   diagram.js#fillDiagramTemplate       Beispieltexte der Vorlagen aus i18n
//
// Setup: linkedom liefert window/document für die DOM-Helfer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div class="page-content-view--editing" contenteditable="true"></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.innerWidth = 1000;
window.innerHeight = 800;
// linkedom hat weder Selection noch Range-Setter: schlanke Attrappen, die nur
// festhalten, wohin der Caret gesetzt wurde.
const fakeSel = {
  ranges: [],
  get rangeCount() { return this.ranges.length; },
  removeAllRanges() { this.ranges = []; },
  addRange(r) { this.ranges.push(r); },
  getRangeAt(i) { return this.ranges[i]; },
};
document.getSelection = () => fakeSel;
document.createRange = () => ({
  startContainer: null, startOffset: 0, collapsed: true,
  setStart(n, o) { this.startContainer = n; this.startOffset = o; },
  collapse() {},
});

const { computePopoverPos } = await import('../../public/js/popover-anchor.js');
const {
  blockInsertTarget, placeBlockNode, placeCaretInSlotAfter,
} = await import('../../public/js/editor/notebook/toolbar/caret-panel.js');
const { DIAGRAM_TEMPLATES, fillDiagramTemplate } = await import('../../public/js/editor/notebook/toolbar/diagram.js');

const editor = () => document.querySelector('.page-content-view--editing');
function setEditor(html) {
  const el = editor();
  el.innerHTML = html;
  return el;
}
const caretIn = (node, offset = 0) => ({ startContainer: node, startOffset: offset, collapsed: true });

// ── computePopoverPos ───────────────────────────────────────────────────────

test('computePopoverPos: Default (unten bevorzugt, Layout-Viewport) unverändert', () => {
  const r = { top: 100, bottom: 120, left: 500, right: 540 };
  assert.deepEqual(computePopoverPos(r, 200, 100), { top: 124, left: 340 });
  // Unten kein Platz → darüber.
  const low = { top: 750, bottom: 770, left: 500, right: 540 };
  assert.equal(computePopoverPos(low, 200, 100).top, 750 - 100 - 4);
});

test('computePopoverPos: prefer above + center, Flip nach unten und Klemmen ans Band', () => {
  const band = { top: 0, left: 0, width: 375, height: 400 };
  // Oben ist Platz: über dem Anker, mittig.
  const mid = { top: 300, bottom: 320, left: 150, right: 170 };
  const a = computePopoverPos(mid, 200, 120, { align: 'center', prefer: 'above', band });
  assert.equal(a.top, 300 - 120 - 4);
  assert.equal(a.left, 60);
  // Oben zu wenig Platz → darunter.
  const top = { top: 40, bottom: 60, left: 150, right: 170 };
  assert.equal(computePopoverPos(top, 200, 120, { align: 'center', prefer: 'above', band }).top, 64);
  // Rechts am Rand (375px): horizontal ins Band geklemmt.
  const right = { top: 300, bottom: 320, left: 360, right: 370 };
  const c = computePopoverPos(right, 300, 120, { align: 'center', prefer: 'above', band });
  assert.equal(c.left, 375 - 300 - 8);
});

test('computePopoverPos: Band mit Offset (Tastatur verschiebt den visualViewport)', () => {
  const band = { top: 200, left: 0, width: 375, height: 300 };
  // Anker knapp unter der Bandoberkante: oben kein Platz → darunter, nicht
  // über die Bandkante hinaus nach oben.
  const r = { top: 220, bottom: 240, left: 100, right: 120 };
  const p = computePopoverPos(r, 200, 150, { align: 'center', prefer: 'above', band });
  assert.ok(p.top >= 200 + 8, `top ${p.top} liegt im Band`);
  assert.ok(p.top + 150 <= 500 - 8, 'unten im Band');
});

// ── blockInsertTarget / placeBlockNode ─────────────────────────────────────

test('blockInsertTarget: leerer Absatz wird ersetzt, voller bekommt den Block dahinter', () => {
  const el = setEditor('<p>Text</p><p><br></p>');
  const [full, empty] = el.querySelectorAll('p');
  assert.deepEqual(blockInsertTarget(el, caretIn(empty)), { replace: empty, after: null });
  assert.deepEqual(blockInsertTarget(el, caretIn(full.firstChild, 2)), { replace: null, after: full });
  assert.deepEqual(blockInsertTarget(el, null), { replace: null, after: null });
});

test('blockInsertTarget: Caret in einer Liste → hinter die ganze Liste', () => {
  const el = setEditor('<ul><li>eins</li><li>zwei</li></ul><p>danach</p>');
  const li = el.querySelectorAll('li')[0];
  const t = blockInsertTarget(el, caretIn(li.firstChild, 1));
  assert.equal(t.replace, null);
  assert.equal(t.after, el.querySelector('ul'));
  const node = document.createElement('table');
  placeBlockNode(el, node, t);
  assert.equal(node.parentNode, el, 'Block hängt am Editor-Root, nicht in der Liste');
  assert.equal(el.querySelector('ul').nextElementSibling, node);
});

test('placeBlockNode: ersetzt den leeren Block, ohne Ziel ans Ende', () => {
  const el = setEditor('<p>a</p><p><br></p>');
  const empty = el.querySelectorAll('p')[1];
  const fig = document.createElement('figure');
  placeBlockNode(el, fig, { replace: empty });
  assert.equal(empty.isConnected, false);
  assert.equal(el.lastElementChild, fig);
  const pre = document.createElement('pre');
  placeBlockNode(el, pre, {});
  assert.equal(el.lastElementChild, pre);
});

// ── placeCaretInSlotAfter ──────────────────────────────────────────────────

test('placeCaretInSlotAfter: legt den Absatz an oder nimmt den vorhandenen', () => {
  const el = setEditor('<p>a</p>');
  const table = document.createElement('table');
  el.appendChild(table);
  placeCaretInSlotAfter(table);
  const slot = table.nextElementSibling;
  assert.equal(slot?.tagName, 'P', 'Absatz hinter dem Block angelegt');
  const sel = document.getSelection();
  assert.equal(sel.getRangeAt(0).startContainer, slot);

  // Dahinter ein atomarer Block → kein Caret hinein, neuer Absatz dazwischen.
  const el2 = setEditor('<table></table><pre contenteditable="false">x</pre>');
  const t2 = el2.querySelector('table');
  placeCaretInSlotAfter(t2);
  assert.equal(t2.nextElementSibling.tagName, 'P');
  assert.equal(t2.nextElementSibling.nextElementSibling.tagName, 'PRE');
});

// ── Diagramm-Vorlagen ──────────────────────────────────────────────────────

test('fillDiagramTemplate: Beispieltexte kommen aus der Übersetzung, Syntax bleibt', () => {
  const en = {
    'editor.diagram.tplText.flow.start': 'Starting point',
    'editor.diagram.tplText.flow.decision': 'Decision',
    'editor.diagram.tplText.flow.yes': 'yes',
    'editor.diagram.tplText.flow.no': 'no',
    'editor.diagram.tplText.flow.outcomeA': 'Outcome A',
    'editor.diagram.tplText.flow.outcomeB': 'Outcome B',
  };
  const flow = DIAGRAM_TEMPLATES.find((t) => t.key === 'flow');
  const code = fillDiagramTemplate(flow, (k) => en[k]);
  assert.equal(code, 'flowchart TD\n  A[Starting point] --> B{Decision}\n  B -->|yes| C[Outcome A]\n  B -->|no| D[Outcome B]');
  // Kein Text in der Vorlage selbst: jede Vorlage besteht ohne Übersetzung nur
  // aus Syntax + Platzhalternamen.
  for (const tpl of DIAGRAM_TEMPLATES) {
    assert.doesNotMatch(tpl.code, /[äöüÄÖÜ]|Ausgangslage|Entscheidung|Thema|Frage/, `${tpl.key}: deutscher Text im Code`);
  }
});

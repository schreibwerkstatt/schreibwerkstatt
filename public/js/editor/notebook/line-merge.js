// Notebook-Editor: Zeilen verschmelzen und Auswahlen löschen, ohne dass
// Chromium seinen nativen Merge fährt. Der bäckt beim Verschmelzen verschieden
// gestylter Blöcke (Absatz ↔ Zitat, Absatz ↔ Verlaufszeile, Listenzeile mit
// Unterliste) die berechneten CSS-Werte als Inline-`style` ein — die harte Regel
// „Löschen an Blockgrenzen" in public/js/editor/CLAUDE.md.
//
// Framework-frei und ohne Toolbar-`this`: Konsumenten sind die Keydown-Handler
// der Notebook-Toolbar (toolbar/keydown-delete.js, toolbar/keydown.js) und der
// Cut-Pfad des Notebooks (edit/input.js). Nicht in shared/: der Focus-Editor
// und der Standalone-Mount der nativen Clients nutzen diese Pfade nicht.

import { findBlock } from '../shared/dom-block.js';
import { mergeBlocksManually } from '../shared/block-edge.js';
import { TODO_ITEM_SEL, TODO_TEXT_SEL } from '../shared/todo-html.js';

export const isListEl = (n) => n?.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL');

// Direkte Unterlisten einer Listenzeile.
export function directLists(el) {
  return el ? Array.from(el.children).filter(isListEl) : [];
}

// Die Zeilen der Unterlisten von `li` rücken an dessen Stelle (eine Ebene
// höher), in Dokumentordnung. Nötig, bevor `li` verschwindet oder sein Inhalt in
// einen Block wandert, der keine Liste tragen darf (`<p>`, Überschrift).
export function promoteSubLists(li) {
  const parent = li?.parentNode;
  for (const list of directLists(li)) {
    if (isListEl(parent)) {
      while (list.firstChild) parent.insertBefore(list.firstChild, li);
      list.remove();
    } else {
      parent?.insertBefore(list, li.nextSibling);
    }
  }
}

// Letzte sichtbare Zeile eines Blocks: bei einer Listenzeile mit Unterliste die
// tiefste letzte Zeile darin — dorthin gehört angehängter Text, nicht hinter
// die Unterliste.
export function deepestLastLine(block) {
  let cur = block;
  let guard = 16;
  while (guard-- > 0 && cur?.tagName === 'LI') {
    const lists = directLists(cur);
    const last = lists[lists.length - 1]?.lastElementChild;
    if (!last) break;
    cur = last;
  }
  return cur;
}

// Zeile vor einer Listenzeile in Leserichtung (über Ebenen hinweg), sonst null.
export function prevListLine(li) {
  if (li.previousElementSibling) return deepestLastLine(li.previousElementSibling);
  const up = li.parentNode?.parentNode;
  return up?.tagName === 'LI' ? up : null;
}

// Zeile nach einer Listenzeile in Leserichtung (über Ebenen hinweg), sonst null.
export function nextListLine(li) {
  const sub = directLists(li)[0]?.firstElementChild;
  if (sub) return sub;
  let n = li;
  let guard = 16;
  while (guard-- > 0 && n?.tagName === 'LI') {
    if (n.nextElementSibling) return n.nextElementSibling;
    const up = n.parentNode?.parentNode;
    if (up?.tagName !== 'LI') break;
    n = up;
  }
  return null;
}

// Steht der (kollabierte) Caret am Ende des eigenen Textes einer Listenzeile —
// also vor ihrer ersten Unterliste? Ohne Unterliste: am Zeilenende.
export function caretAtLineEnd(range, block) {
  if (!range.collapsed) return false;
  const r = document.createRange();
  r.setStart(range.startContainer, range.startOffset);
  const sub = block.tagName === 'LI' ? directLists(block)[0] : null;
  if (sub) r.setEndBefore(sub);
  else r.setEnd(block, block.childNodes.length);
  return r.toString().length === 0;
}

// Text-Träger einer Zeile: in der Checkbox-Liste das `.todo-text`-Span (die
// Checkbox ist Struktur, nie Inhalt), sonst der Block selbst.
export function lineTextEl(block) {
  if (block?.matches?.(TODO_ITEM_SEL)) return block.querySelector(TODO_TEXT_SEL) || block;
  return block;
}

// Verschmilzt `source` ans Ende von `receiver` wie `mergeBlocksManually`, aber
// listenfest: Unterlisten der Quelle rücken an ihre Stelle (statt in einem
// `<p>` zu landen), und eine Unterliste des Empfängers bleibt HINTER dem
// angehängten Text stehen (statt dass der Text hinter ihr landet).
export function mergeLines(receiver, source) {
  if (source.tagName === 'LI') promoteSubLists(source);
  const held = receiver.tagName === 'LI' ? directLists(receiver) : [];
  held.forEach((l) => l.remove());
  mergeBlocksManually(receiver, source);
  for (const l of held) {
    if (l.querySelector('li')) receiver.appendChild(l);
  }
}

// Leer gewordene Hüllen ab `node` aufwärts entfernen (bis `root` exklusive).
export function removeEmptyAncestors(node, root) {
  let cur = node;
  let guard = 16;
  while (guard-- > 0 && cur && cur !== root && cur.isConnected && root.contains(cur)) {
    const parent = cur.parentNode;
    if (cur.nodeType !== 1 || cur.children.length || (cur.textContent || '').trim()) break;
    cur.remove();
    cur = parent;
  }
}

// Atomare Insel (Chip, Tabelle, Diagramm, Bildnachweis) — dort beginnt oder
// endet keine Auswahl, die wir selbst löschen.
const inAtomic = (node, root) => {
  const el = node?.nodeType === 3 ? node.parentNode : node;
  const hit = el?.closest?.('[contenteditable="false"]');
  return !!hit && root.contains(hit);
};

// Löscht die aktuelle Auswahl selbst, wenn sie über eine Blockgrenze reicht:
// Inhalt dazwischen weg (`Range.deleteContents`), dann die beiden Randblöcke
// über `mergeLines` zusammenführen und leere Hüllen räumen. Innerhalb eines
// Blocks bleibt es beim Browser (dort entsteht kein Inline-`style`).
// Rückgabe: true = gelöscht, Caret steht an der Naht.
export function deleteRangeClean(root) {
  const sel = root ? document.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
  if (inAtomic(range.startContainer, root) || inAtomic(range.endContainer, root)) return false;
  const a = findBlock(range.startContainer, root);
  const b = findBlock(range.endContainer, root);
  if (!a || !b || a === b) return false;
  range.deleteContents();
  const receiver = lineTextEl(a);
  const source = lineTextEl(b);
  if (!a.isConnected || !b.isConnected || receiver === source) {
    sel.removeAllRanges();
    range.collapse(true);
    sel.addRange(range);
    return true;
  }
  const after = b.parentNode;
  // Eine Checkbox-Zeile verliert beim Verschmelzen ihr Span; die Zeile selbst
  // (mit Checkbox) muss mit, sonst bliebe eine leere Checkbox-Zeile stehen.
  const sourceRow = source !== b ? b : null;
  // Steckt die Quelle in der Unterliste des Empfängers, nicht vorher ausräumen —
  // `mergeLines` hält diese Unterliste selbst fest.
  mergeLines(receiver, source);
  if (sourceRow?.isConnected) sourceRow.remove();
  removeEmptyAncestors(after, root);
  return true;
}

// Teilt `wrapper` (Gedicht, Checkbox-Liste, Verlauf) an der Zeile `line`: die
// Zeile verschwindet, an ihrer Stelle steht ein leerer Absatz zwischen den
// beiden Hälften. Ist `line` die letzte Zeile, steht der Absatz einfach hinter
// dem Block (= Block verlassen). `keepTail: false` (Fokusmodus): Absatz hinter
// dem ganzen Block, die Folgezeilen bleiben drin. Liefert den neuen Absatz.
export function splitWrapperAtLine(line, wrapper, { keepTail = true } = {}) {
  const out = document.createElement('p');
  out.appendChild(document.createElement('br'));
  const rest = [];
  if (keepTail) {
    for (let n = line.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
  }
  line.remove();
  wrapper.parentNode.insertBefore(out, wrapper.nextSibling);
  if (rest.length) {
    // Eigene Hülle statt `cloneNode`: die Block-ID (`data-bid`) darf nicht
    // doppelt im Dokument stehen.
    const tail = document.createElement(wrapper.localName);
    if (wrapper.className) tail.className = wrapper.className;
    rest.forEach((n) => tail.appendChild(n));
    out.insertAdjacentElement('afterend', tail);
  }
  if (!wrapper.children.length) wrapper.remove();
  return out;
}

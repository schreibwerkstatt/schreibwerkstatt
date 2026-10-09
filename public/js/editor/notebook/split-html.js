// Abschnitt teilen (Notebook-Editor): Kopf und Schwanz aus dem Editor-DOM
// am Caret schneiden. Rein DOM-basiert, ohne Selection-/Range-API und ohne
// Alpine — arbeitet auf einer KOPIE des Editier-Containers, damit der Live-
// Editor bis zur Server-Bestätigung unangetastet bleibt (unit-getestet mit
// linkedom: tests/unit/notebook-split-html.test.mjs).
//
// Schnittregel:
//   - Caret in einem Top-Level-Absatz/-Überschrift (`SPLITTABLE_TAGS`):
//     am Anfang → Grenze VOR dem Block, am Ende → Grenze DAHINTER, sonst wird
//     der Block am Caret in zwei Blöcke gleichen Typs zerlegt (Inline-Formate
//     werden auf beiden Seiten fortgeführt). Die zweite Hälfte verliert ihre
//     `data-bid` — der Server vergibt eine frische, die erste Hälfte behält sie.
//   - Caret in jedem anderen Top-Level-Block (Liste, Zitat, Gedicht, Tabelle,
//     Abbildung, Diagramm …) → Grenze VOR diesem Block; er wandert ganz.
//   - Leere Absätze direkt an der Schnittstelle fallen weg (der Leerabsatz, in
//     dem das Slash-Menü geöffnet wurde, ist kein Inhalt).
// Ganze Blöcke behalten ihre `data-bid`, damit Anker (Kommentare eines
// Kapitel-/Buch-Links, Querverweis-Ziele) mit dem Block auf die neue Seite
// ziehen.

export const SPLITTABLE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Inhalt, der zählt, auch ohne Text (Bild, Linie, Tabelle, Diagramm).
const MEDIA_SEL = 'img, hr, table, figure, pre';
const MEDIA_TAGS = new Set(['IMG', 'HR', 'TABLE', 'FIGURE', 'PRE']);
const VOID_TAGS = new Set(['BR', 'IMG', 'HR', 'INPUT', 'WBR']);

function _indexOf(node) {
  return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

// Kindindex-Pfad von `root` bis `node` (beide inklusive Ausgangslage), oder
// null, wenn `node` nicht unter `root` liegt. Überträgt einen Punkt aus dem
// Live-Editor auf dessen Kopie.
export function nodePath(root, node) {
  const path = [];
  let cur = node;
  while (cur && cur !== root) {
    if (!cur.parentNode) return null;
    path.unshift(_indexOf(cur));
    cur = cur.parentNode;
  }
  return cur === root ? path : null;
}

export function resolvePath(root, path) {
  let cur = root;
  for (const i of path || []) {
    cur = cur?.childNodes?.[i];
    if (!cur) return null;
  }
  return cur;
}

export function hasContent(node) {
  if (!node) return false;
  if (node.nodeType === 3) return node.data.trim() !== '';
  if (node.nodeType !== 1) return false;
  if ((node.textContent || '').trim() !== '') return true;
  return MEDIA_TAGS.has(node.tagName) || !!node.querySelector?.(MEDIA_SEL);
}

// Sichtbarer Text im Block vor bzw. hinter dem Punkt (container, offset).
function _textAround(block, container, offset) {
  let before = '';
  let after = '';
  let passed = false;
  const target = container.nodeType === 3 ? container : (container.childNodes[offset] || null);
  const walk = (n) => {
    if (n === target) {
      if (n.nodeType === 3) {
        before += n.data.slice(0, offset);
        after += n.data.slice(offset);
        passed = true;
        return;
      }
      passed = true;
    }
    if (n.nodeType === 3) {
      if (passed) after += n.data; else before += n.data;
      return;
    }
    if (n.nodeType === 1 && MEDIA_TAGS.has(n.tagName)) {
      if (passed) after += '■'; else before += '■';
    }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  // Punkt hinter dem letzten Kind (target null): nichts matcht, alles landet
  // in `before`.
  walk(block);
  return { before, after };
}

// Zerlegt `block` am Punkt in zwei Geschwister: alles ab dem Punkt wandert in
// flache Klone der jeweiligen Vorfahren, Ebene für Ebene bis zum Block. Liefert
// den Klon des Blocks (die zweite Hälfte), der direkt hinter `block` steht.
function _splitBlock(block, container, offset) {
  let parent;
  let idx;
  if (container.nodeType === 3) {
    const rest = container.ownerDocument.createTextNode(container.data.slice(offset));
    container.data = container.data.slice(0, offset);
    container.parentNode.insertBefore(rest, container.nextSibling);
    parent = container.parentNode;
    idx = _indexOf(rest);
  } else {
    parent = container;
    idx = offset;
  }
  for (;;) {
    const clone = parent.cloneNode(false);
    while (parent.childNodes.length > idx) clone.appendChild(parent.childNodes[idx]);
    parent.parentNode.insertBefore(clone, parent.nextSibling);
    if (parent === block) return clone;
    idx = _indexOf(clone);
    parent = parent.parentNode;
  }
}

// Inline-Hüllen, die der Schnitt leer zurückgelassen hat (`<em></em>`).
function _dropEmptyInline(el) {
  for (const c of Array.from(el.querySelectorAll('*')).reverse()) {
    if (VOID_TAGS.has(c.tagName)) continue;
    if (!c.childNodes.length) c.remove();
  }
}

function _isBlankBlock(node) {
  if (node.nodeType === 3) return node.data.trim() === '';
  return node.nodeType === 1 && SPLITTABLE_TAGS.has(node.tagName) && !hasContent(node);
}

/**
 * Schneidet `root` (eine Kopie des Editier-Containers — wird verändert) am
 * Punkt (container, offset).
 * @returns {{ headHtml: string, tailHtml: string } | { error: 'outside' | 'edge' }}
 *   `outside`: Punkt liegt nicht im Container. `edge`: eine Seite bliebe leer.
 */
export function splitAtPoint(root, container, offset) {
  if (!container || (container !== root && !root.contains(container))) return { error: 'outside' };
  let boundary;
  if (container === root) {
    boundary = Math.max(0, Math.min(offset, root.childNodes.length));
  } else {
    let top = container;
    while (top.parentNode !== root) top = top.parentNode;
    const topIdx = _indexOf(top);
    if (top.nodeType === 1 && SPLITTABLE_TAGS.has(top.tagName)) {
      const { before, after } = _textAround(top, container, offset);
      if (before.trim() === '') boundary = topIdx;
      else if (after.trim() === '') boundary = topIdx + 1;
      else {
        const second = _splitBlock(top, container, offset);
        second.removeAttribute('data-bid');
        for (const d of second.querySelectorAll('[data-bid]')) d.removeAttribute('data-bid');
        _dropEmptyInline(top);
        _dropEmptyInline(second);
        boundary = topIdx + 1;
      }
    } else {
      boundary = topIdx;
    }
  }
  const nodes = Array.from(root.childNodes);
  const head = nodes.slice(0, boundary);
  const tail = nodes.slice(boundary);
  while (head.length && _isBlankBlock(head[head.length - 1])) head.pop();
  while (tail.length && _isBlankBlock(tail[0])) tail.shift();
  if (!head.some(hasContent) || !tail.some(hasContent)) return { error: 'edge' };
  const doc = root.ownerDocument;
  const pack = (list) => {
    const box = doc.createElement('div');
    for (const n of list) box.appendChild(n);
    return box.innerHTML;
  };
  return { headHtml: pack(head), tailHtml: pack(tail) };
}

/**
 * Bequemer Einstieg für den Live-Editor: Punkt auf eine Kopie übertragen und
 * dort schneiden. Der Live-Container bleibt unverändert.
 */
export function splitEditorAt(editEl, container, offset) {
  const path = container === editEl ? [] : nodePath(editEl, container);
  if (!path) return { error: 'outside' };
  const copy = editEl.cloneNode(true);
  const point = resolvePath(copy, path);
  if (!point) return { error: 'outside' };
  return splitAtPoint(copy, point, offset);
}

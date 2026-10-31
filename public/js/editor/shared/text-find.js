// Geteilter Find-Kern der beiden Editoren mit Text-Suche: Notebook-Editor
// (editor/find.js — ein contenteditable-Root) und Bucheditor
// (cards/book-editor/find.js — N Block-Roots über den ganzen Manuskript-Stream).
// Focus-Editor hat keine Suche.
//
// Enthält ausschliesslich DOM-Mathematik + die Highlight-Registrierung; kein
// Alpine-State, kein `this`. Die Aggregation über mehrere Roots und das
// Ersetzen bleiben beim Konsumenten — der Kern kennt genau einen Root.
//
// Wortgrenze (`wholeWord`): dieselbe Semantik wie die Wortauswahl der Editoren
// (editor/utils.js#isWordChar — Buchstaben/Ziffern inkl. Bindestrich und
// Apostroph) plus `_`. Bewusst EINE Regel für beide Editoren: dasselbe Buch
// wird in beiden gelesen, «Haus» darf in «Haus-Tür» nicht je nach Editor mal
// Ganzwort-Treffer sein und mal nicht.

import { isWordChar } from '../utils.js';

const isFindWordChar = (ch) => !!ch && (isWordChar(ch) || ch === '_');

// Flache Liste aller Text-Nodes unterhalb von `root`.
export function collectTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Match-Positionen im konkatenierten Text auf (Text-Node, Offset)-Tupel
// zurückmappen. Ein Match darf über mehrere Text-Nodes desselben Absatzes laufen;
// `starts` hat Lücken an den Absatzgrenzen (siehe textRuns).
function mapOffset(nodes, starts, globalStart, length) {
  const globalEnd = globalStart + length;
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i];
    const e = s + nodes[i].nodeValue.length;
    if (startNode == null && globalStart >= s && globalStart <= e) {
      startNode = nodes[i];
      startOffset = globalStart - s;
    }
    if (globalEnd >= s && globalEnd <= e) {
      endNode = nodes[i];
      endOffset = globalEnd - s;
      break;
    }
  }
  return { startNode, startOffset, endNode, endOffset };
}

// Elemente, die einen Text NICHT unterbrechen. Alles andere (Absatz, Überschrift,
// Listenpunkt, Zelle, Gedichtzeile, `<br>`, Bild …) ist eine Grenze. Bewusst
// eine Inline-Liste statt einer Blockliste: ein unbekanntes Element trennt —
// lieber einen Treffer über eine exotische Grenze verpassen, als beim Ersetzen
// zwei Absätze zu verschmelzen.
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS',
  'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'VAR',
]);

const isInlineEl = (el) => INLINE_TAGS.has(el.tagName?.toUpperCase());

// Nächster nicht-inline Vorfahr innerhalb von `root` (bzw. `root` selbst).
function boundaryOf(node, root) {
  let cur = node.parentNode;
  while (cur && cur !== root && isInlineEl(cur)) cur = cur.parentNode;
  return cur || root;
}

// Text-Nodes samt konkateniertem Text. Zwischen zwei Nodes, die eine Grenze
// trennt, steht ein `\n` im Gesamttext (ohne Node dahinter): ein Treffer läuft
// so nie über eine Absatzgrenze, und für die Ganzwort-Regel ist das Absatzende
// ein Wortende. Ohne Trenner wäre «…das Haus</h2><p>Der…» der Text «HausDer».
function textRuns(root) {
  const nodes = [];
  const starts = [];
  let full = '';
  let pendingBreak = false;
  let prevBoundary = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      if (!isInlineEl(n)) pendingBreak = true;
      continue;
    }
    const boundary = boundaryOf(n, root);
    if (nodes.length && (pendingBreak || boundary !== prevBoundary)) full += '\n';
    pendingBreak = false;
    prevBoundary = boundary;
    nodes.push(n);
    starts.push(full.length);
    full += n.nodeValue;
  }
  return { nodes, starts, full };
}

// Alle Treffer von `term` unterhalb von `root`, in Dokumentreihenfolge.
// Liefert `[{ startNode, startOffset, endNode, endOffset }]` — leeres Array
// bei leerem Term oder fehlendem Root. Treffer bleiben innerhalb eines Absatzes
// (siehe textRuns).
export function collectMatches(root, term, { caseSensitive = false, wholeWord = false } = {}) {
  if (!root || !term) return [];
  const { nodes, starts, full } = textRuns(root);
  const hay = caseSensitive ? full : full.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();

  const matches = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    if (wholeWord) {
      const before = idx > 0 ? hay[idx - 1] : '';
      const after = hay[idx + needle.length] || '';
      if (isFindWordChar(before) || isFindWordChar(after)) { from = idx + 1; continue; }
    }
    matches.push(mapOffset(nodes, starts, idx, needle.length));
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

// Range aus einem Match. Wirft, wenn sich das DOM zwischenzeitlich geändert
// hat — Aufrufer fangen das und rechnen im nächsten Tick neu.
export function rangeOf(m) {
  const r = document.createRange();
  r.setStart(m.startNode, m.startOffset);
  r.setEnd(m.endNode, m.endOffset);
  return r;
}

// Gilt ein gemerkter Treffer noch? Nach der Suche getippter Text verschiebt die
// Offsets, und `rangeOf` zeigte dann auf anderen Text — Ersetzen träfe die
// falsche Stelle. Geteilt von Notebook-Finder (editor/find.js) und Bucheditor
// (cards/book-editor/find.js).
export function matchStillValid(m, term, caseSensitive) {
  if (!m?.startNode?.isConnected || !m?.endNode?.isConnected) return false;
  try {
    const text = rangeOf(m).toString();
    return caseSensitive ? text === term : text.toLowerCase() === String(term).toLowerCase();
  } catch {
    return false;
  }
}

// Registriert das Highlight-Paar (alle Treffer / aktueller Treffer) unter zwei
// CSS-Namen und kapselt das Neuzeichnen. Bewusst eine Factory statt Modul-
// Singletons: sonst braucht jeder Konsument seine eigene `_hlAll/_hlCurrent`-
// Kopie und die Namen driften von der Zeichen-Logik weg.
//
// Die Highlights gehören zum Dokument, nicht zum DOM-Baum — sie landen also
// nie im gespeicherten Seiten-HTML. Ohne CSS-Custom-Highlight-API im Browser
// sind `paint`/`clear` No-ops; die Navigation bleibt funktional.
export function createHighlightPair(allName, currentName) {
  let hlAll = null, hlCurrent = null;

  const ensure = () => {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
    if (!hlAll) { hlAll = new Highlight(); CSS.highlights.set(allName, hlAll); }
    if (!hlCurrent) { hlCurrent = new Highlight(); CSS.highlights.set(currentName, hlCurrent); }
    return true;
  };

  const clear = () => {
    if (hlAll) hlAll.clear();
    if (hlCurrent) hlCurrent.clear();
  };

  // Zeichnet die Trefferliste neu; `currentIndex` bekommt das Current-Highlight.
  const paint = (matches, currentIndex) => {
    if (!ensure()) return;
    clear();
    if (!matches?.length) return;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (!m.startNode || !m.endNode) continue;
      try {
        const r = rangeOf(m);
        if (i === currentIndex) hlCurrent.add(r);
        else hlAll.add(r);
      } catch { /* Match ungültig (DOM-Mutation) – überspringen */ }
    }
  };

  return { paint, clear };
}

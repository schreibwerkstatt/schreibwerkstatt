// Grenzschutz beim Löschen: Backspace am Anfang bzw. Delete am Ende eines
// Blocks, soweit der Editor es nicht dem Browser überlässt. Framework-frei —
// zwei Konsumenten:
//   • Notebook-Toolbar (notebook/toolbar/block-edge.js) — Notebook und der
//     Fokusmodus der SPA.
//   • Standalone-Mount des Focus-Editors (focus/standalone.js) — die nativen
//     Clients (macOS, Android), die keine Toolbar laden.
// Liegt deshalb hier und nicht in der Toolbar: was die Toolbar importiert,
// gehört nicht ins OTA-Bundle der Clients.

import { findBlock, topLevelBlock, caretAtBlockStart, caretAtBlockEnd } from './dom-block.js';
import { isTableEl } from '../../table/table-html.js';

// Absatz-artige Top-Level-Blöcke, deren Verschmelzung über eine Absatzgrenze
// hinweg (Backspace am Anfang / Delete am Ende) wir bei weichen Umbrüchen
// selbst übernehmen. Listen, Tabellen, Gedichte, <pre>, <hr> bleiben aussen
// vor — dort ist das native bzw. das HR-Verhalten gewünscht.
export const MERGE_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Blöcke, die sich wie ein einzelnes Zeichen verhalten, aber keinen Caret
// aufnehmen: sie lassen sich nicht selektieren, also gibt es ohne eigenen
// Lösch-Pfad überhaupt keinen. `<hr>` ist ein echtes void-Element; ein
// `<figure>` ist es nicht, hat aber dieselbe Eigenschaft — die einzige
// Caret-Position darin ist die `<figcaption>`, und für das Bild selbst gibt es
// (anders als bei `<hr>`, siehe `hr-selected`) keine Klick-Auswahl.
export const ATOMIC_BLOCK_TAGS = new Set(['HR', 'FIGURE']);

// Backspace am Anfang bzw. Delete am Ende eines Blocks bei leerer Auswahl →
// `{ block, top, back, outer }`, sonst null. `top` ist der umschliessende
// Top-Level-Block; `outer` sagt, ob der Caret damit auch an dessen Rand steht
// (erster bzw. letzter Kind-Block auf jeder Ebene dazwischen).
export function caretEdge(e, root) {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return null;
  const sel = root ? document.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  const block = findBlock(range.startContainer, root);
  if (!block) return null;
  const back = e.key === 'Backspace';
  if (!(back ? caretAtBlockStart(range, block) : caretAtBlockEnd(range, block))) return null;
  const top = topLevelBlock(block, root);
  let outer = true;
  for (let n = block; n !== top; n = n.parentNode) {
    if (back ? n.previousElementSibling : n.nextElementSibling) { outer = false; break; }
  }
  return { block, top, back, outer };
}

// Zwei Geschwisterblöcke, die sich ohne Strukturverlust verschmelzen lassen.
const mergeable = (a, b) => (MERGE_BLOCK_TAGS.has(a.tagName) && MERGE_BLOCK_TAGS.has(b.tagName))
  || (a.tagName === 'LI' && b.tagName === 'LI');

// Verschmilzt `source` (gesamter Inhalt inkl. weicher <br>-Umbrüche) ans Ende
// von `receiver` und entfernt `source`. Setzt den Caret an die Naht zwischen
// Alt-Inhalt und angehängtem Inhalt. Ersetzt das native Merge-Verhalten, das
// bei <br>-haltigen Absätzen nur die erste Zeile übernimmt und den Rest zu
// einem neuen Absatz abspaltet.
export function mergeBlocksManually(receiver, source) {
  // Ein alleinstehendes <br> ist Platzhalter, nicht Inhalt: auf BEIDEN Seiten
  // wegräumen, sonst bleibt eine Leerzeile vor (Receiver) bzw. hinter (Source)
  // dem angehängten Text stehen. Der Source-Fall tritt nur über den Checkbox-
  // Pfad auf — `_kbDeleteBlock` merged ausschliesslich Quellen mit Text.
  const placeholderOnly = (el) => el.childNodes.length === 1 && el.firstChild.nodeName === 'BR';
  if (placeholderOnly(receiver)) receiver.removeChild(receiver.firstChild);
  if (placeholderOnly(source)) source.removeChild(source.firstChild);
  const anchor = receiver.lastChild; // Naht-Anker (null, wenn Receiver leer war)
  while (source.firstChild) receiver.appendChild(source.firstChild);
  source.remove();
  const sel = document.getSelection();
  if (!sel) return;
  const r = document.createRange();
  if (anchor && anchor.nodeType === 3) r.setStart(anchor, anchor.textContent.length);
  else if (anchor) r.setStartAfter(anchor);
  else r.setStart(receiver, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// Backspace am Anfang des Blocks NACH einem geschützten Block bzw. Delete am
// Ende des Blocks DAVOR, auch aus einem Wrapper heraus (letzte Zitatzeile,
// erste Listenzeile). Geschützt ist:
//   • eine Tabelle, in beiden Modi — der Löschweg ist der „Entfernen"-Knopf im
//     Tabellen-Dialog (docs/tabellen.md). Der Default löscht sie im Focus-
//     Editor mit einem Druck, im Notebook zieht er den Absatz-Text aus seinem
//     `<p>`.
//   • mit `atomic: true` (SPA-Fokusmodus) zusätzlich `<figure>` und `<hr>`
//     (ATOMIC_BLOCK_TAGS): das Bild steht dort nur als gedimmtes Symbol, die
//     Trennlinie gar nicht sichtbar — ein Druck, der sie löscht, fiele nicht
//     auf. Im Notebook entfernt `_kbDeleteBlock` sie bewusst wie ein Zeichen.
// Ein LEERER Block an der Grenze verschwindet dagegen, sonst gäbe es keinen
// Weg, eine Leerzeile dort loszuwerden; der Caret wechselt dann auf die
// andere Seite des Blocks. `onChange` läuft nur, wenn das DOM sich ändert.
// Rückgabe: true = Taste behandelt (preventDefault gesetzt).
export function protectNeighbour(e, root, { atomic = false, onChange } = {}) {
  const edge = caretEdge(e, root);
  if (!edge?.outer) return false;
  const { top, back } = edge;
  const n = back ? top.previousElementSibling : top.nextElementSibling;
  if (!n || !(isTableEl(n) || (atomic && ATOMIC_BLOCK_TAGS.has(n.tagName)))) return false;
  e.preventDefault();
  const other = back ? top.nextElementSibling : top.previousElementSibling;
  const empty = !(top.textContent || '').trim() && !top.querySelector('img, input');
  if (!empty || !other?.isContentEditable) return true;
  top.remove();
  const sel = document.getSelection();
  const r = document.createRange();
  r.selectNodeContents(other);
  r.collapse(back);
  sel.removeAllRanges();
  sel.addRange(r);
  onChange?.();
  return true;
}

// Focus-Editor: Merge zweier Geschwisterblöcke selbst übernehmen — Top-Level-
// Absätze ebenso wie Zeilen in Zitat, Gedicht und Liste. Der aktive Absatz
// trägt eine eigene Spotlight-Farbe, Chromium bäckt diesen Unterschied beim
// Merge als Inline-`style` ein; im `.poem` (Focus-CSS: `display: contents`)
// verwirft der Default sogar ganze Verse. Grenzen zu Wrappern, Checkbox-Listen
// und Tabellen haben eigene Handler, die vorher laufen müssen; ein Konsument
// ohne diese Handler nimmt die Blöcke mit `skipSel` aus (sie bleiben dann beim
// Default). Eine Listenzeile mit eingebetteter Unterliste bleibt beim Default,
// statt die Unterliste in die Zeile darüber zu kippen.
// Rückgabe: true = Taste behandelt, DOM geändert (`onChange` lief).
export function focusMerge(e, root, { skipSel = null, onChange } = {}) {
  const edge = caretEdge(e, root);
  if (!edge) return false;
  const { block, back } = edge;
  const neighbour = back ? block.previousElementSibling : block.nextElementSibling;
  if (!neighbour || !mergeable(block, neighbour)) return false;
  if (skipSel && (block.closest(skipSel) || neighbour.closest(skipSel))) return false;
  const source = back ? block : neighbour;
  if (source.querySelector('ul, ol')) return false;
  e.preventDefault();
  mergeBlocksManually(back ? neighbour : block, source);
  onChange?.();
  return true;
}

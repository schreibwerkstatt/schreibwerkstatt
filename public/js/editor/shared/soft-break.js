// Weicher Zeilenumbruch (Shift+Enter) — SSoT für die Editoren, die den
// Soft-Break selbst setzen statt ihn dem Browser zu überlassen.
//
// Konsumenten: Notebook-Toolbar (via Re-Export in notebook/toolbar/_shared.js)
// und der Focus-Editor (focus/listeners.js). Der Focus-Pfad darf den
// Toolbar-Modulgraph nicht importieren — er läuft auch in der Standalone-Shell
// der nativen Clients, die keine Toolbar-Karte mountet.

import { findBlock, caretAtBlockEnd } from './dom-block.js';

// Steht links vom (kollabierten) Caret schon ein <br>? Dann würde ein weiterer
// Soft-Break einen zweiten aufeinanderfolgenden <br> erzeugen, den
// collapseEmptyBlocks (utils.js) beim Save ohnehin wegräumt — der User sähe zwei
// Umbrüche, von denen nach dem Reload nur einer überlebt. Whitespace-Textknoten
// zwischen <br> und Caret werden übersprungen (exakt die, die der Collapse auch
// ignoriert). Inline-Element-Grenzen werden bewusst nicht überstiegen; den
// seltenen Rest fängt der Cleaner verlustfrei ab.
export function brLeftOfCaret(sel) {
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const c = range.startContainer;
  const o = range.startOffset;
  let probe;
  if (c.nodeType === 3) {
    if (c.nodeValue.slice(0, o).trim() !== '') return false; // echter Text links → erlauben
    probe = c.previousSibling;
  } else {
    probe = o > 0 ? c.childNodes[o - 1] : null;
  }
  while (probe && probe.nodeType === 3 && !probe.nodeValue.trim()) {
    probe = probe.previousSibling;
  }
  return !!(probe && probe.nodeType === 1 && probe.tagName === 'BR');
}

// Weichen Umbruch als <br>-ELEMENT setzen. Für Container, die auf ihren Blöcken
// `white-space: pre-wrap` fahren (Focus-Editor, Invariante 11c): dort schreibt
// `execCommand('insertLineBreak')` ein rohes `\n` statt eines <br> (gemessen:
// mitten im Text ein `\n`, am Blockende deren zwei). Das `\n` rendert nur unter
// pre-wrap als Umbruch — in Notebook-Leseansicht, Share-Reader und allen
// Exporten kollabiert es zum Leerzeichen. Der Umbruch wäre nach dem Speichern
// still verloren, ohne Fehlermeldung und ohne dass es beim Schreiben auffällt.
//
// Liefert true, wenn das Event konsumiert ist (auch beim Dedup-No-Op).
export function insertSoftBreak(container) {
  const sel = container?.ownerDocument?.getSelection?.() || document.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  if (!container || !container.contains(sel.getRangeAt(0).startContainer)) return false;

  // Auswahl zuerst löschen, danach ist der Caret kollabiert und die beiden
  // Zweige unten greifen wie bei leerer Auswahl.
  if (!sel.isCollapsed) document.execCommand('delete');
  // Links steht schon ein <br> → kein zweiter (siehe brLeftOfCaret).
  if (brLeftOfCaret(sel)) return true;

  const doc = container.ownerDocument || document;
  const block = findBlock(sel.getRangeAt(0).startContainer, container) || container;

  // Beide Lagen setzen den Umbruch von Hand, kein execCommand:
  //   - Mitten im Text macht WebKit aus `insertHTML('<br>')` einen
  //     Absatzwechsel (`<p>Eins</p><br> zwei…` statt `<p>Eins<br> zwei…</p>`,
  //     gemeldet als `insertText`) — Safari und der macOS-Client teilten den
  //     Absatz, statt weich umzubrechen.
  //   - Am Blockende fügt `insertHTML` in Chromium nichts ein UND setzt den
  //     Caret in den nächsten Absatz.
  // Rückgängig machbar bleibt der Umbruch über die eigene Undo-Historie des
  // Fokusmodus (Invariante 19): sie hängt am `input`-Event unten, nicht am
  // nativen Stack — Cmd/Ctrl+Z erreicht den Browser dort gar nicht.
  //
  // Am Blockende zwei <br>, Caret dazwischen: ein einzelnes <br> am Blockende
  // erzeugt keine sichtbare Leerzeile, der Caret bliebe optisch auf der alten
  // (gemessen — die Blockhöhe wächst erst beim Paar). Genau dieses Paar erzeugt
  // Chromiums `insertLineBreak` am Blockende auch im Notebook; an der Persistenz
  // ändert sich also nichts: bleibt die Zeile leer, kollabiert
  // collapseEmptyBlocks das Paar beim Save auf ein <br>.
  const atEnd = caretAtBlockEnd(sel.getRangeAt(0), block);
  const range = sel.getRangeAt(0).cloneRange();
  const br = doc.createElement('br');
  const frag = doc.createDocumentFragment();
  frag.appendChild(br);
  if (atEnd) frag.appendChild(doc.createElement('br'));
  range.insertNode(frag);

  const after = doc.createRange();
  after.setStartAfter(br);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);

  // Manuelle DOM-Mutation feuert kein `input` — synthetisch nachreichen, sonst
  // bleibt die Seite un-dirty, die Absatz-Markierung unrepariert und der
  // Typewriter unrecentert. `dispatchEvent` ist synchron, die Mark-Reparatur
  // läuft also im selben Task (Invariante 18).
  container.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

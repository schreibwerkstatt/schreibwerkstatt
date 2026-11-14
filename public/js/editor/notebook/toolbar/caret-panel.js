// Bausteine der caret-verankerten Panels des Notebook-Editors: Link-Bar
// (bubble.js), Beleg-Picker (cite.js), Querverweis-Picker (xref.js) und der
// Block-Dialoge (table.js, diagram.js, image.js).
//
// Alle folgen derselben Choreografie — Range beim Öffnen sichern, Panel über
// der Range verankern, beim Übernehmen an genau dieser Range einfügen, Caret
// dahinter setzen, schliessen und den Editor wieder fokussieren; beim Verwerfen
// den Caret dorthin zurück, wo er vor dem Öffnen stand. Ausgeschrieben wurde
// davon jeder Schritt mehrfach; hier steht er einmal. Die Positionierung am
// sichtbaren Band (Methoden mit `this`) liegt in panel-methods.js.
//
// Nur Notebook: Focus-Editor und Bucheditor stellen die erzeugten Marker dar,
// bringen aber keinen Einfügepfad mit (harte Regel „Editor-Spezifikation").
//
// Was hier NICHT hingehört: was gesucht, formatiert und eingefügt wird. Das ist
// je Panel genuin verschieden und bleibt in cite.js/xref.js/bubble.js.

import { findBlock, topLevelBlock } from '../../shared/dom-block.js';
import { getEditEl, placeCaretAfter, placeCaretIn } from '../../utils.js';
import { ensureSlotAfter, replaceBlockOutsideList, historyStep } from './_shared.js';
import { MSG_THREAD_SEL } from '../../../messages/msg-html.js';
import { isImeComposing } from '../../../utils/keys.js';

export { placeCaretAfter };

// ── Panel-Anker ───────────────────────────────────────────────────────────

// Anker-Rechteck (Viewport-Koordinaten) für ein Panel an `range`. Eine
// kollabierte Range hat oft kein Rechteck (leerer Absatz, Caret vor einem
// atomaren Chip) — dann auf den umgebenden Block ausweichen, sonst klebte das
// Panel in der linken oberen Ecke. Die Range ist live: nach Scroll oder
// Umbruch liefert derselbe Aufruf die neue Lage (Nachziehen in panel-methods.js).
export function panelAnchorRect(range, editEl) {
  let rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const block = findBlock(range.startContainer, editEl) || editEl;
    rect = block.getBoundingClientRect();
  }
  return rect;
}

// ── Caret zurück ──────────────────────────────────────────────────────────

/**
 * Editor fokussieren und die beim Öffnen gesicherte Range zurücksetzen.
 *
 * Ohne den zweiten Schritt setzt `editEl.focus()` den Caret an den Anfang des
 * Abschnitts: beim Öffnen hat das Panel-Eingabefeld (bzw. der Dialog) den Fokus
 * und damit die Selektion übernommen, der Editor weiss nicht mehr, wo der User
 * stand. Gilt für jedes Verwerfen (Esc, Klick daneben, ×/Abbrechen).
 *
 * Ohne `force` bleibt eine Selektion, die der User inzwischen selbst in den
 * Editor gesetzt hat, unangetastet — der Klick daneben, der das Panel schliesst,
 * IST dann die neue Caret-Position. Die Block-Dialoge geben `force`: das native
 * `<dialog>` gibt den Fokus beim Schliessen an den Editor zurück, ohne die
 * Selektion mitzunehmen.
 *
 * @param {Range|null|undefined} range
 * @param {{force?: boolean}} [opts]
 */
export function restoreEditorRange(range, { force = false } = {}) {
  const editEl = getEditEl();
  if (!editEl) return;
  const active = editEl.ownerDocument?.activeElement;
  const userMovedIn = !force && active && (active === editEl || editEl.contains(active));
  if (userMovedIn) return;
  editEl.focus({ preventScroll: true });
  const node = range?.startContainer;
  if (!node || !node.isConnected || !editEl.contains(node)) return;
  const sel = editEl.ownerDocument.getSelection?.();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Caret in den Absatz HINTER einem eingefügten atomaren Block (Tabelle,
 * Diagramm, Abbildung, O-Ton). Der Block selbst nimmt keinen Caret an; steht
 * dahinter nichts oder etwas, das keinen Caret trägt, entsteht ein leerer
 * Absatz (`ensureSlotAfter`) — dort schreibt der User weiter.
 */
export function placeCaretInSlotAfter(node) {
  if (!node?.isConnected) return;
  let slot = ensureSlotAfter(node) || node.nextElementSibling;
  const writable = slot && /^(P|H[1-6])$/.test(slot.tagName)
    && slot.getAttribute('contenteditable') !== 'false';
  if (!writable) {
    const p = node.ownerDocument.createElement('p');
    p.appendChild(node.ownerDocument.createElement('br'));
    node.insertAdjacentElement('afterend', p);
    slot = p;
  }
  getEditEl()?.focus({ preventScroll: true });
  placeCaretIn(slot);
}

// ── Block am Caret einsetzen (Seiten-Toolbar) ─────────────────────────────

/**
 * Wohin ein Block aus der Seiten-Toolbar kommt: ein leerer Caret-Block wird
 * ersetzt (wie beim Slash-Menü), sonst landet der Block HINTER dem
 * Top-Level-Block des Carets — nie mitten in einen Absatz oder in eine Liste.
 * Caret in einer Bildunterschrift: hinter die Abbildung. Ohne Caret: ans Ende.
 *
 * @returns {{replace: Element|null, after: Element|null}}
 */
// Leerer Platzhalter-Block, den ein eingesetzter Block ersetzen darf.
const isEmptySlot = (block) => !(block.textContent || '').trim()
  && !block.querySelector('img, table, pre, hr, [contenteditable="false"]');

export function blockInsertTarget(editEl, range) {
  const block = range ? findBlock(range.startContainer, editEl) : null;
  if (!block) {
    // `figcaption` steht nicht in CARET_BLOCK_SEL — ohne diesen Zweig landete
    // der Block am Ende des Abschnitts statt hinter der Abbildung.
    const node = range?.startContainer;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    const fig = el?.closest?.('figure');
    const top = fig && editEl.contains(fig) ? topLevelBlock(fig, editEl) : null;
    return { replace: null, after: top && top !== editEl ? top : null };
  }
  if (isEmptySlot(block)) return { replace: block, after: null };
  const top = topLevelBlock(block, editEl);
  return { replace: null, after: top && top !== editEl ? top : null };
}

// Wrapper, in die kein eingesetzter Block gehört: ein leerer Caret-Absatz darin
// wird nicht ersetzt, der Block steht HINTER dem Wrapper, die leere Zeile fällt
// weg. Ein Verlauf trägt nur Zeilen (`MSG_LINE_SEL`), ein Gedicht nur Verse,
// und eine Tabelle im Zitat wäre im Export ein eingerücktes Zitat.
const INSERT_ESCAPE_SEL = `blockquote, div.poem, ${MSG_THREAD_SEL}`;

/**
 * Block-Knoten nach `blockInsertTarget` einsetzen. `replace` läuft über
 * `replaceBlockOutsideList` (Invariante 19: nie in eine Liste) — liegt der
 * leere Block in Zitat, Gedicht oder Verlauf, landet `node` hinter diesem
 * Wrapper; ist er inzwischen nicht mehr leer, kommt `node` dahinter. `after`
 * hinter den Top-Level-Block, sonst ans Ende.
 */
export function placeBlockNode(editEl, node, { replace = null, after = null } = {}) {
  historyStep();
  // Das Ziel wurde vor Dialog bzw. Upload bestimmt. Hat der User inzwischen in
  // den leeren Block getippt, wird er nicht samt Text ersetzt — der neue Block
  // kommt dann dahinter.
  if (replace?.isConnected && editEl.contains(replace) && !isEmptySlot(replace)) {
    after = topLevelBlock(replace, editEl);
    replace = null;
  }
  if (replace && replace.isConnected && replace.parentNode && editEl.contains(replace)) {
    const wrap = replace.parentElement?.closest(INSERT_ESCAPE_SEL);
    if (wrap && editEl.contains(wrap) && wrap !== editEl) {
      topLevelBlock(wrap, editEl).insertAdjacentElement('afterend', node);
      replace.remove();
      if (!wrap.children.length && !(wrap.textContent || '').trim()) wrap.remove();
    } else {
      replaceBlockOutsideList(editEl, replace, node);
    }
  } else if (after && after.isConnected && after.parentNode === editEl) {
    after.insertAdjacentElement('afterend', node);
  } else {
    editEl.appendChild(node);
  }
}

// ── HTML einfügen ─────────────────────────────────────────────────────────
//
// IMMER über die Range-/DOM-API, NIE über execCommand('insertHTML'): Chromium
// schleust den Fragment-String durch seinen Editing-Sanitizer, der `class` und
// `data-*` verwirft und die berechneten CSS-Werte der Klasse als Inline-`style`
// einbäckt. Aus einem Beleg-Chip würde `<span style="color: rgb(...)">` — der
// `data-src`-Zeiger (die Wahrheit) wäre weg, und das `style`-Attribut verstiesse
// gegen „Styles nur in public/css" und wäre im Dark-Mode falsch. Dieselbe
// Chromium-Eigenheit steckt hinter der Blockgrenzen-Löschbehandlung
// (docs/notebook-editor.md, Invarianten 17+18).

// Markup-String zu einem DocumentFragment. `lastNode` ist der letzte erzeugte
// Knoten — der Anker für den Caret danach.
export function htmlToFragment(html, doc = document) {
  const holder = doc.createElement('div');
  holder.innerHTML = html;
  const frag = doc.createDocumentFragment();
  while (holder.firstChild) frag.appendChild(holder.firstChild);
  return { frag, lastNode: frag.lastChild };
}

// Markup-String zu genau EINEM Element (null, wenn das Markup keines liefert).
// Für die Panels, die einen bestehenden Knoten ersetzen statt einzufügen.
export function htmlToElement(html, doc = document) {
  const holder = doc.createElement('div');
  holder.innerHTML = html;
  return holder.firstElementChild;
}

// Geschütztes Leerzeichen als benannte Konstante. Der Beleg-Chip trennt damit
// (statt mit einem gewöhnlichen Leerzeichen), weil er `contenteditable="false"`
// und `white-space: nowrap` trägt: ein normales Leerzeichen direkt hinter einem
// atomaren Inline-Element am Blockende kollabiert weg und lässt keinen
// Caret-Slot übrig, in den der User weiterschreiben könnte. Steht die Quelle am
// Absatzende, trimmt der Server-Cleaner es beim Speichern (stripBlockEdgeNbsp).
//
// Als Literal im Quelltext war das ein unsichtbares Zeichen — hier hat es einen
// Namen. Der Querverweis benutzt bewusst weiterhin ein gewöhnliches Leerzeichen
// (`after: ' '`): er ist Fliesstext im Satz, kein abgesetzter Nachweis.
export const NBSP = '\u00A0';

/**
 * Markup an einer gesicherten Range einfügen und den Caret dahinter setzen.
 *
 * @param {Range} range
 * @param {string} html
 * @param {object} [opts]
 * @param {string}  [opts.after]           Trennzeichen hinter dem Markup, damit
 *   der User direkt weiterschreiben kann (siehe NBSP).
 * @param {boolean} [opts.replaceContents] Range-Inhalt löschen statt behalten.
 *   Default false — ein Beleg weist die markierte Stelle NACH, er ersetzt sie
 *   nicht (anders als beim Link, wo die Selektion der Linktext ist).
 * @returns {Node|null} der letzte eingefügte Knoten
 */
export function insertHtmlAtRange(range, html, { after = '', replaceContents = false } = {}) {
  historyStep();
  if (!range || !html) return null;
  const doc = range.startContainer?.ownerDocument || document;
  const { frag, lastNode } = htmlToFragment(html + after, doc);
  if (replaceContents) range.deleteContents();
  else if (!range.collapsed) range.collapse(false);
  range.insertNode(frag);
  if (lastNode) placeCaretAfter(lastNode);
  return lastNode;
}

/**
 * Markup ans ENDE eines Hosts hängen (statt an eine Range). Für Belege am
 * Blockzitat: der Kurzbeleg weist dort das ganze Zitat nach, nicht die Stelle,
 * an der der Cursor zufällig stand.
 *
 * Setzt bewusst KEINEN Caret — anders als `insertHtmlAtRange`. Der Host kann
 * hier noch losgelöst vom Dokument sein (O-Ton-Block, der erst danach eingehängt
 * wird), und dann zeigte der Caret auf einen abgehängten Knoten. Aufrufer, die
 * ihn brauchen, rufen `placeCaretAfter(lastNode)` selbst.
 *
 * @returns {Node|null} der letzte angehängte Knoten
 */
export function appendHtmlInto(host, html, { before = '' } = {}) {
  if (!host || !html) return null;
  const doc = host.ownerDocument || document;
  const { frag, lastNode } = htmlToFragment(before + html, doc);
  host.appendChild(frag);
  return lastNode;
}

// ── Trefferliste + Tastatur ───────────────────────────────────────────────

// Zyklisch durch die Trefferliste (↑ am Anfang springt ans Ende und umgekehrt).
export function cycleIdx(idx, delta, len) {
  if (!len) return 0;
  return ((idx + delta) % len + len) % len;
}

// Liste auf `max` kappen. Der Deckel ist Absicht: mehr als ~40 Zeilen scannt
// niemand, und bei dreistelligen Literaturverzeichnissen bzw. langen Büchern
// soll der Picker nicht zur Endlosliste werden.
export function capHits(list, max) {
  return list.length > max ? list.slice(0, max) : list;
}

/**
 * Tastatur-Vertrag aller Picker: Escape schliesst, ↑/↓ bewegen die Auswahl,
 * Enter übernimmt den markierten Treffer. Jeder behandelte Zweig ruft
 * `preventDefault` — die Panels liegen über einem contenteditable, wo die
 * Browser-Defaults (Scroll, Zeilenumbruch) den Text verändern würden, und das
 * Vollbild des Editors (editor-notebook.html) verlässt Esc nur, wenn kein Layer
 * es verbraucht hat.
 *
 * Zwei Ausnahmen:
 *   • Während einer IME-Komposition gehört jede Taste der Zeichenwahl (Enter
 *     bestätigt sie, Esc bricht sie ab) — nichts wird behandelt.
 *   • ↑/↓/Enter wirken nur in einem Textfeld des Panels (Filter, Stellenangabe).
 *     Steht der Fokus auf einem Knopf (Zitat-Art, Anzeigeform, Entfernen), drückt
 *     Enter diesen Knopf, statt den markierten Treffer einzufügen.
 *
 * @returns {boolean} ob das Event behandelt wurde
 */
export function onPickerKeydown(e, { onClose, onMove, onEnter }) {
  if (isImeComposing(e)) return false;
  if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return true; }
  const inField = e.target?.tagName === 'INPUT';
  if (!inField) return false;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); onMove?.(1); return true;
    case 'ArrowUp':   e.preventDefault(); onMove?.(-1); return true;
    case 'Enter':     e.preventDefault(); onEnter?.(); return true;
    default: return false;
  }
}

// Geteilter Paste-/Copy-/Cut-Handler für alle drei Editoren (Notebook, Focus,
// Bucheditor) und die Notebook-Leseansicht (Copy). Paste behält nur Whitelist-
// Tags via sanitizePasteHtml; ohne Tag-Inhalt fällt es auf Plain-Text zurück.
// Copy/Cut schreiben text/plain UND eine bereinigte text/html-Fassung
// (`clipboardHtml`): Einfügen im Editor behält damit Auszeichnung, Links,
// Quellen-Chips und Querverweise, fremde Apps bekommen weder Inline-Styles noch
// Lektorat-Marks, Editor-UI oder Laufzeit-Attribute.

import { sanitizePasteHtml } from '../../utils.js';
import { stripLektoratMarks } from './html-clean.js';
import { isCiteEl } from '../../sources/cite-html.js';
import { isXrefEl } from '../../xrefs/xref-html.js';
import { TODO_TEXT_SEL } from './todo-html.js';

// Behandelt ein Paste-Event komplett: preventDefault, Sanitize, Insert.
// Rückgabe: true wenn etwas eingefügt wurde, false bei leerem Clipboard.
// Caller markiert anschliessend dirty (kann Block-spezifisch sein).
// `opts.tables`: Tabellen im Clipboard als Tabellen einfügen (nur Notebook,
// ausserhalb des Fokusmodus — dort ist Tabellen-Eingabe zu Hause). Sonst
// werden sie zu Absätzen, eine Zeile je Absatz (sanitizePasteHtml).
// Konsumenten: Notebook (edit/input.js, mit `tables` ausserhalb des
// Fokusmodus) und Bucheditor (book-editor/activation.js, ohne).
export function handleEditorPaste(e, { tables = false } = {}) {
  const cd = e.clipboardData;
  if (!cd) return false;
  e.preventDefault();

  const plain = cd.getData('text/plain') || '';
  // Kopie aus dem Editor selbst (Notebook ausserhalb des Fokusmodus): die
  // Struktur-Fassung mit Abbildung, Diagramm und Checkbox-Liste.
  const own = tables ? cd.getData(EDITOR_CLIP_TYPE) : '';
  const html = own || cd.getData('text/html');
  if (html) {
    const cleaned = sanitizePasteHtml(html, { tables, structure: !!own });
    if (cleaned && /<[a-z]/i.test(cleaned)) {
      document.execCommand('insertHTML', false, cleaned);
      return true;
    }
    const text = plain || (cleaned || '');
    if (text) {
      document.execCommand('insertText', false, text);
      return true;
    }
    return false;
  }
  if (plain) {
    document.execCommand('insertText', false, plain);
    return true;
  }
  return false;
}

// Paste als reiner Text — keine Formatierung, kein Whitelist-HTML. Nur
// text/plain wird via insertText eingefügt. Für den Focus-Standalone-Editor
// (ablenkungsfreier Schreibmodus, auch der eingebettete macOS-Client): fremdes
// Markup hat hier nichts zu suchen.
// Rückgabe: true wenn etwas eingefügt wurde, false bei leerem Clipboard.
export function handleEditorPastePlain(e) {
  const cd = e.clipboardData;
  if (!cd) return false;
  e.preventDefault();
  const plain = cd.getData('text/plain') || '';
  if (!plain) return false;
  document.execCommand('insertText', false, plain);
  return true;
}

// Bereinigte HTML-Fassung eines kopierten Ausschnitts. Erhalten bleiben Blöcke,
// Inline-Auszeichnung, Links sowie Quellen-Chips und Querverweise in ihrem
// SSoT-Markup (Klasse + data-Zeiger) — `sanitizePasteHtml` lässt genau die beim
// Einfügen wieder durch. Weg sind: Lektorat-/Chat-Marks, LanguageTool-UI,
// Vorschau-Nummern, Fokus-Markierungen (`stripLektoratMarks`), jedes `style`,
// `contenteditable` und `data-bid` (eine eingefügte Kopie bekäme sonst die ID
// ihres Originals), gerenderte Diagramm-Bilder (der Quelltext reist mit),
// Checkboxen und jede `<span>`-Hülle, die weder Chip noch Querverweis ist
// (Figuren-/Orts-Markierungen der Leseansicht).
//
// `structure: true` ist die Fassung für den Editor selbst (eigener Clipboard-
// Typ `EDITOR_CLIP_TYPE`): Checkboxen und das `.todo-text`-Span bleiben, damit
// eine kopierte Checkbox-Liste als solche zurückkommt. Abbildungen und
// Diagramm-Quelltext stehen in beiden Fassungen; fremde Apps sehen sie, der
// Editor lässt sie nur aus der eigenen Fassung wieder herein.
export function clipboardHtml(html, { structure = false } = {}) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body><div>${stripLektoratMarks(html)}</div></body></html>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';
  root.querySelectorAll(structure ? 'svg, script, style' : 'svg, input, script, style').forEach((el) => el.remove());
  root.querySelectorAll('[style], [contenteditable], [data-bid]').forEach((el) => {
    el.removeAttribute('style');
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-bid');
  });
  for (const span of Array.from(root.querySelectorAll('span'))) {
    if (isCiteEl(span) || isXrefEl(span)) continue;
    if (structure && span.matches(TODO_TEXT_SEL)) continue;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
  }
  return root.innerHTML;
}

// Clipboard-Typ der editor-internen Fassung. Fremde Apps lesen ihn nicht; ein
// Einfügen im Notebook bevorzugt ihn vor `text/html`.
export const EDITOR_CLIP_TYPE = 'text/x-schreibwerkstatt-html';

// Text- und HTML-Fassung der aktuellen Auswahl ins Clipboard. Rückgabe: true,
// wenn geschrieben wurde (preventDefault gesetzt).
// Eine Auswahl ohne Text (nur ein Bild, eine Trennlinie) zählt mit — sonst
// kopierte der Browser-Default sie mit Inline-Styles und Laufzeit-Attributen.
function writeSelection(e, sel) {
  const text = sel.toString();
  const box = document.createElement('div');
  box.appendChild(sel.getRangeAt(0).cloneContents());
  if (!text && !box.querySelector('img, hr, table, pre')) return false;
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
  const html = clipboardHtml(box.innerHTML);
  if (html) e.clipboardData.setData('text/html', html);
  const own = clipboardHtml(box.innerHTML, { structure: true });
  if (own) e.clipboardData.setData(EDITOR_CLIP_TYPE, own);
  return true;
}

// Copy: text/plain + bereinigtes text/html. Rückgabe: true wenn Override aktiv
// wurde, false wenn keine Selektion (Browser-Default greift dann nicht, weil
// es nichts zu kopieren gibt).
export function handleEditorCopy(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  return writeSelection(e, sel);
}

// Cut: wie Copy, dann die Selektion löschen. `deleteSelection` (optional) löscht
// selbst und liefert true, wenn es übernommen hat — das Notebook reicht hier
// seinen blockgrenzen-festen Löschweg herein (notebook/line-merge.js), weil
// `execCommand('delete')` über eine Blockgrenze Inline-`style` einbäckt. Ohne
// ihn bzw. bei false: `execCommand('delete')`. Caller markiert anschliessend
// dirty.
export function handleEditorCut(e, { deleteSelection = null } = {}) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  if (!writeSelection(e, sel)) return false;
  if (!(deleteSelection && deleteSelection())) document.execCommand('delete');
  return true;
}

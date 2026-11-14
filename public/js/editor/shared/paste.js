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

// Behandelt ein Paste-Event komplett: preventDefault, Sanitize, Insert.
// Rückgabe: true wenn etwas eingefügt wurde, false bei leerem Clipboard.
// Caller markiert anschliessend dirty (kann Block-spezifisch sein).
export function handleEditorPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return false;
  e.preventDefault();

  const plain = cd.getData('text/plain') || '';
  const html = cd.getData('text/html');
  if (html) {
    const cleaned = sanitizePasteHtml(html);
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
export function clipboardHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body><div>${stripLektoratMarks(html)}</div></body></html>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';
  root.querySelectorAll('svg, input, script, style').forEach((el) => el.remove());
  root.querySelectorAll('[style], [contenteditable], [data-bid]').forEach((el) => {
    el.removeAttribute('style');
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-bid');
  });
  for (const span of Array.from(root.querySelectorAll('span'))) {
    if (isCiteEl(span) || isXrefEl(span)) continue;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
  }
  return root.innerHTML;
}

// Text- und HTML-Fassung der aktuellen Auswahl ins Clipboard. Rückgabe: true,
// wenn geschrieben wurde (preventDefault gesetzt).
function writeSelection(e, sel) {
  const text = sel.toString();
  if (!text) return false;
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
  const box = document.createElement('div');
  box.appendChild(sel.getRangeAt(0).cloneContents());
  const html = clipboardHtml(box.innerHTML);
  if (html) e.clipboardData.setData('text/html', html);
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

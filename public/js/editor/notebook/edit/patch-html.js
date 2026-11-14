// Notebook-Editor: neuen Inhalt blockweise statt komplett einhängen.
// Konsumenten: Übernahmen im Edit-Modus (edit/input.js — Abschnitts-Chat
// «Übernehmen»/«Rückgängig», Lektorat-Befunde). Eine Übernahme ändert meist
// einen Absatz; ein Komplett-Mount (`mountEditorHtml`) ersetzt bei einem 34K-
// Abschnitt alle Blöcke, kostet 50–60 ms (4× gedrosselt), wirft den Caret an
// den Abschnittsanfang und reisst alle Highlight-Ranges ab.
//
// Der Tausch selbst ist derselbe wie beim Undo-Restore
// (shared/edit-history.js#swapChangedBlocks): gemeinsamer Anfang und
// gemeinsames Ende der Top-Level-Blöcke bleiben Live-Knoten, nur die Mitte
// läuft durch `mountEditorHtml` und wird getauscht. Ausgangsstand ist die
// Save-Normalform (`oldHtml` = `stripLektoratMarks(el.innerHTML)`) — passt
// ihre Blockzahl nicht zum Live-Editor (z.B. ein offenes LanguageTool-Popover
// als eigene Insel), wird komplett eingehängt.

import { mountEditorHtml } from '../../shared/mount-html.js';
import { htmlToBlocks, swapChangedBlocks } from '../../shared/edit-history.js';

// Liefert true, wenn blockweise getauscht wurde, false nach Komplett-Mount.
export function patchEditorHtml(el, oldHtml, nextHtml) {
  const doc = el.ownerDocument;
  let part = null;
  try {
    part = swapChangedBlocks(el, htmlToBlocks(oldHtml, doc), htmlToBlocks(nextHtml, doc), mountEditorHtml);
  } catch { part = null; }
  if (part) return true;
  mountEditorHtml(el, nextHtml);
  return false;
}

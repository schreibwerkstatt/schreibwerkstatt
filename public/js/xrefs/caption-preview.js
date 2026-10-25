// Nummern in Abbildungslegenden und Tabellenbeschriftungen der LESEANSICHTEN.
//
// Das Problem, das dieses Modul loest: „Abb. 3.2" ist eine Eigenschaft des
// Ausgabewegs und entsteht erst beim Export (lib/xref-render.js). Am Bildschirm
// stand die Legende deshalb nackt da — wer pruefen wollte, ob „vgl. Abb. 3.2"
// im Text auf die richtige Abbildung zeigt, musste erst ein PDF bauen.
//
// NICHTS DAVON WIRD PERSISTIERT. Die Nummer haengt als eigenes Element
// (`span.xref-num`) VOR dem Legendentext, nie im Text selbst, und wird an drei
// Stellen wieder entfernt:
//
//   1. hier, vor jedem neuen Lauf (`clearCaptionNumbers`) — der Lauf ist damit
//      idempotent;
//   2. in der Dirty-Vergleichsform des Editors
//      (editor/shared/html-clean.js#stripLektoratMarks) — sonst gaelte jede
//      Seite mit Abbildung beim blossen Hinsehen als veraendert;
//   3. serverseitig am Schreib-Chokepoint
//      (lib/html-clean.js#stripEditorUiArtefacts) — die tragende Schicht. Was
//      dort faellt, kann auf keinem Schreibweg in `pages.content` landen.
//
// Dieselbe Bauart wie das LanguageTool-Popover, aus demselben Grund: ein
// Laufzeit-Element im bearbeitbaren Inhalt braucht eine Bereinigung am
// Chokepoint, nicht eine sorgfaeltige Aufrufreihenfolge.
//
// KEINE NUMMER OHNE SCHALTER: nummeriert ein Buch seine Abbildungen nicht
// (`book_settings.figure_numbering`), zeigt auch die Vorschau keine — sonst
// stuende am Bildschirm eine Zahl, die im fertigen Dokument fehlt. Abbildungen
// und Tabellen haben dafuer je einen eigenen Schalter.

import { loadXrefTargets, previewNumbers } from './target-cache.js';
import { captionPrefix } from './xref-format.js';
import { FIGURE_ANCHOR_SEL, TABLE_ANCHOR_SEL } from './xref-anchor.js';

export const XREF_NUM_CLASS = 'xref-num';
export const XREF_NUM_SEL = 'span.xref-num';

// Traeger je Typ — dieselbe Zuordnung wie im Renderer
// (lib/xref-render.js#applyXrefsInHtml).
const CAPTIONED = [
  { sel: FIGURE_ANCHOR_SEL, kind: 'figure', capSel: 'figcaption' },
  { sel: TABLE_ANCHOR_SEL, kind: 'table', capSel: 'caption' },
];

/** Alle Nummern-Badges unter `root` entfernen. */
export function clearCaptionNumbers(root) {
  if (!root?.querySelectorAll) return;
  for (const el of Array.from(root.querySelectorAll(XREF_NUM_SEL))) el.remove();
}

/** Nummern-Badges unter `root` setzen.
 *
 *  Idempotent, auch bei ueberlappenden Laeufen: raeumt vor und nach dem Laden
 *  auf, danach steht vor jeder Beschriftung genau ein Badge. Fehlschlaege (kein Buch, Netz weg, Buch ohne Nummerierung) enden
 *  still mit einer Leseansicht ohne Nummern — das ist der Stand von vorher und
 *  keine Stoerung, die eine Meldung verdient.
 *
 *  @returns {Promise<number>} Anzahl gesetzter Badges. */
export async function stampCaptionNumbers(root, bookId) {
  clearCaptionNumbers(root);
  if (!root?.querySelectorAll || !bookId) return 0;
  // Billiger Vorab-Test, bevor die Zielliste geholt wird: die allermeisten
  // Seiten tragen weder Abbildung noch Tabelle.
  if (!root.querySelector(`${FIGURE_ANCHOR_SEL}, ${TABLE_ANCHOR_SEL}`)) return 0;

  let data;
  try {
    data = await loadXrefTargets(bookId);
  } catch {
    return 0;
  }
  // Nach dem `await` NOCHMAL aufraeumen: zwei Laeufe auf demselben Container
  // (Rueckkehr aus dem Edit-Modus aendert HTML und Modus im selben Tick, beide
  // Watcher stossen einen Lauf an) haben beide vor dem `await` geraeumt und
  // setzten danach beide ein — zwei Badges vor einer Legende. Ab hier laeuft
  // alles synchron, der letzte Lauf hinterlaesst also genau ein Badge.
  clearCaptionNumbers(root);
  if (!data.figureNumbering && !data.tableNumbering) return 0;

  const { figNums, tblNums } = previewNumbers(data);
  const doc = root.ownerDocument || globalThis.document;
  let n = 0;

  for (const { sel, kind, capSel } of CAPTIONED) {
    if (kind === 'figure' && !data.figureNumbering) continue;
    if (kind === 'table' && !data.tableNumbering) continue;
    const nums = kind === 'figure' ? figNums : tblNums;
    for (const el of Array.from(root.querySelectorAll(sel))) {
      const bid = String(el.getAttribute('data-bid') || '').trim().toLowerCase();
      const prefix = captionPrefix(kind, nums.get(bid), data.lang);
      if (!prefix) continue;
      const cap = el.querySelector(capSel);
      if (!cap) continue;
      const badge = doc.createElement('span');
      badge.className = XREF_NUM_CLASS;
      // Auch in der Leseansicht gesetzt: der Bucheditor schaltet einen Block
      // per Klick auf bearbeitbar, und dann muss der Caret das Badge
      // ueberspringen. Das Attribut wird nie persistiert (siehe Modulkopf).
      badge.setAttribute('contenteditable', 'false');
      badge.textContent = prefix;
      cap.insertBefore(badge, cap.firstChild);
      n++;
    }
  }
  return n;
}

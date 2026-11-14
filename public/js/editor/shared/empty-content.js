// Ist ein Abschnitt leer? Eine Definition für Notebook-Editor (Speichern,
// Autosave, Leseansicht) und Bucheditor (Leer-Block-Schutz): weder Text noch
// ein Element, das einen Abschnitt ohne Text trotzdem füllt — ein Abschnitt nur
// mit Bild, Tabelle oder Trennlinie ist kein versehentlich geleerter Abschnitt.
// Pure (DOMParser, kein Live-DOM) und darum unit-testbar. Der Focus-Editor nutzt
// das Modul nicht.

import { htmlToText } from '../../utils.js';

const NON_TEXT_CONTENT_SEL = 'img, table, hr, pre, figure, svg, video, audio, iframe, object, embed';

export function isEmptyManuscript(html) {
  if (htmlToText(html || '').trim()) return false;
  if (typeof DOMParser === 'undefined') return true;
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return !doc.body?.querySelector(NON_TEXT_CONTENT_SEL);
}

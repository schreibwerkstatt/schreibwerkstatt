// Facade der Recherche-/Wissensboard-Karte (Sub-Komponente).
// Buchweit geteiltes Archiv: Notizen, Links, Zitate, Faktensplitter, Bilder —
// optional mit Buch-Entitaeten (Kapitel/Seite/Figur/Ort/Szene/Beat) verknuepfbar
// und ueber Tags filterbar. Rein kuratierend, nie generativ im Buchtext.
// Zwei Ansichten desselben Bestands: Liste (Anriss je Fundstueck) und
// Status-Board (Kanban ueber die Einarbeitungs-Stufen) — recherche/status.js.
// Aufteilung nach Domaene in public/js/book/recherche/ — Konsumenten importieren
// ausschliesslich diese Facade.

import { rechercheBoardMethods } from './recherche/board.js';
import { rechercheItemMethods } from './recherche/items.js';
import { rechercheLinkMethods } from './recherche/links.js';
import { rechercheMediaMethods } from './recherche/media.js';
import { rechercheStatusMethods } from './recherche/status.js';
import { rechercheBulkMethods } from './recherche/bulk.js';
import { rechercheCrosscheckMethods } from './recherche/crosscheck.js';
import { rechercheHistoryMethods } from './recherche/history.js';
import { boardHistoryMethods } from '../cards/board-history.js';

export { rechercheBulkState } from './recherche/bulk.js';
export { rechercheCrosscheckState } from './recherche/crosscheck.js';

export const rechercheMethods = {
  ...rechercheBoardMethods,
  ...rechercheItemMethods,
  ...rechercheLinkMethods,
  ...rechercheMediaMethods,
  ...rechercheStatusMethods,
  ...rechercheBulkMethods,
  ...rechercheCrosscheckMethods,
  // Undo/Redo: Kern cards/board-history.js, Records recherche/history.js.
  ...boardHistoryMethods,
  ...rechercheHistoryMethods,
};

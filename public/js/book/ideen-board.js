// Facade des Ideen-Boards: alle Ideen eines Buches als Kanban ueber die
// Bearbeitungsstufen, die Bahnen sind die Anker im Buch (Kapitel bzw. Seite).
//
// Aufteilung:
//   ideen-board/model.js   — pure Rechnung (Bahnen-Reihenfolge, Gruppierung)
//   ideen-board/actions.js — Laden, Schreiben, Drag&Drop, Filter-Ableitungen
//   ideen-links.js         — Verknuepfungen (geteilt mit der Ideen-Karte)
//   ../picker-popover.js   — am Trigger verankerte Picker (Verknuepfen, Zuordnen)
//   ideen-board/edit-status.js — Bearbeitungsstand je Bahn, «final + offen»
//   ideen-board/list.js    — Listenansicht, Alter, Mehrfachauswahl
//   ideen-board/inline-edit.js — Text einer Karte bearbeiten (Tastatur, Klick ausserhalb)

import { ideenBoardActions } from './ideen-board/actions.js';
import { ideenLinkMethods } from './ideen-links.js';
import { pickerPopoverMethods } from '../picker-popover.js';
import { ideenBoardEditStatus } from './ideen-board/edit-status.js';
import { ideenBoardList } from './ideen-board/list.js';
import { ideenBoardInlineEdit } from './ideen-board/inline-edit.js';

export const ideenBoardMethods = {
  ...ideenBoardActions,
  ...ideenLinkMethods,
  ...pickerPopoverMethods,
  ...ideenBoardEditStatus,
  ...ideenBoardList,
  ...ideenBoardInlineEdit,
};

export { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, boardColumns } from './ideen-board/model.js';

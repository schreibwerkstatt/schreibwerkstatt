// Facade des Ideen-Boards: alle Ideen eines Buches als Kanban ueber die
// Bearbeitungsstufen, die Bahnen sind die Anker im Buch (Kapitel bzw. Seite).
//
// Aufteilung:
//   ideen-board/model.js   — pure Rechnung (Bahnen-Reihenfolge, Gruppierung)
//   ideen-board/actions.js — Laden, Schreiben, Drag&Drop, Filter-Ableitungen
//   ideen-board/add.js     — Anlegen: Ideen (eine je Zeile) und Kapitel («+ Kapitel»)
//   ideen-links.js         — Verknuepfungen (geteilt mit der Ideen-Karte)
//   ../picker-popover.js   — am Trigger verankerte Picker (Verknuepfen, Zuordnen)
//   ideen-board/edit-status.js — Bearbeitungsstand je Bahn, «final + offen»
//   ideen-board/list.js    — Listenansicht, Alter, Mehrfachauswahl
//   ideen-board/inline-edit.js — Text einer Karte bearbeiten (Tastatur, Klick ausserhalb)
//   ideen-board/view-menu.js — Einträge des Ansichts-Menüs (Anzeige, Buch-Stufen, Auto-Check)
//   ideen-board/history.js — Undo/Redo-Records (Kern: cards/board-history.js)
//   ideen-board/menu.js    — Aktionsmenü einer Idee in Raster und Liste
//   ideen-methods-shared.js — Löschen, Stufen-Label (geteilt mit der Ideen-Karte)
//   ideen-check.js         — Hinweise des Auto-Erledigt-Checks (geteilt mit der Ideen-Karte)

import { ideenBoardActions } from './ideen-board/actions.js';
import { ideenBoardAdd } from './ideen-board/add.js';
import { ideenLinkMethods } from './ideen-links.js';
import { pickerPopoverMethods } from '../picker-popover.js';
import { ideenBoardEditStatus } from './ideen-board/edit-status.js';
import { selectionMethods } from '../selection-bar.js';
import { ideenBoardList } from './ideen-board/list.js';
import { ideenBoardInlineEdit } from './ideen-board/inline-edit.js';
import { ideenCheckMethods } from './ideen-check.js';
import { ideenBoardViewMenu } from './ideen-board/view-menu.js';
import { ideenBoardHistory } from './ideen-board/history.js';
import { ideenBoardMenu } from './ideen-board/menu.js';
import { ideenSharedMethods } from './ideen-methods-shared.js';
import { actionMenuMethods } from '../action-menu.js';
import { boardHistoryMethods } from '../cards/board-history.js';

export const ideenBoardMethods = {
  ...ideenSharedMethods,
  ...ideenBoardActions,
  ...ideenBoardAdd,
  ...ideenLinkMethods,
  ...pickerPopoverMethods,
  ...selectionMethods,
  ...ideenBoardEditStatus,
  ...ideenBoardList,
  ...ideenBoardInlineEdit,
  ...ideenCheckMethods,
  ...ideenBoardViewMenu,
  ...actionMenuMethods,
  ...boardHistoryMethods,
  ...ideenBoardHistory,
  ...ideenBoardMenu,
};

export { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, boardColumns } from './ideen-board/model.js';

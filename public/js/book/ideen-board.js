// Facade des Ideen-Boards: alle Ideen eines Buches als Kanban ueber die
// Bearbeitungsstufen, die Bahnen sind die Anker im Buch (Kapitel bzw. Seite).
//
// Aufteilung:
//   ideen-board/model.js   — pure Rechnung (Bahnen-Reihenfolge, Gruppierung)
//   ideen-board/actions.js — Laden, Schreiben, Drag&Drop, Filter-Ableitungen
//   ideen-links.js         — Verknuepfungen (geteilt mit der Ideen-Karte)

import { ideenBoardActions } from './ideen-board/actions.js';
import { ideenLinkMethods } from './ideen-links.js';

export const ideenBoardMethods = {
  ...ideenBoardActions,
  ...ideenLinkMethods,
};

export { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals, boardColumns } from './ideen-board/model.js';

// Facade: Figuren-Werkstatt-Methoden, kombiniert nach Domäne.
// Sub-Module:
//   - mindmap.js     — jsMind-Lifecycle, Topic-i18n-Marker, Fullscreen
//   - crud.js        — Draft-CRUD, Dirty-Tracking, Reset
//   - import.js      — Import bestehender Buch-Figur als Draft
//   - jobs.js        — KI-Brainstorm + Konsistenz-Check (Job-Polling)
//   - runs.js        — KI-Lauf-Historie (persistierte Brainstorm/Consistency-Runs)
//   - bogen.js       — Bogen im Buch (Ist-Index + Messung, Kern x Kapitel)
//   - vorschlaege.js — Vorschlagskarten (Brainstorm, Konsistenz): Übernehmen/Verwerfen
//   - context-menu.js — Rechtsklick-Menü auf Mindmap-Knoten + Figurenliste
//   - history.js     — Rückgängig/Wiederholen + geschütztes Löschen von Knoten
//   - mindmap-view.js — Einpassen, Zoom, Auf-/Zuklappen, Touch-Pan, Knoten-Markierung
//   - mindmap-editor.js — mitwachsende Knoten-Bearbeitung (an der jsMind-Instanz)

import { mindmapMethods, resolveTopic, resolveMindmapForDisplay } from './figur-werkstatt/mindmap.js';
import { crudMethods } from './figur-werkstatt/crud.js';
import { importMethods } from './figur-werkstatt/import.js';
import { jobsMethods } from './figur-werkstatt/jobs.js';
import { runsMethods } from './figur-werkstatt/runs.js';
import { bogenMethods } from './figur-werkstatt/bogen.js';
import { memoMethods } from './cards/card-memo.js';
import { vorschlaegeMethods } from './figur-werkstatt/vorschlaege.js';
import { contextMenuMethods } from './figur-werkstatt/context-menu.js';
import { historyMethods } from './figur-werkstatt/history.js';
import { mindmapViewMethods } from './figur-werkstatt/mindmap-view.js';

export const figurWerkstattMethods = {
  ...crudMethods,
  ...importMethods,
  ...mindmapMethods,
  ...jobsMethods,
  ...runsMethods,
  ...bogenMethods,
  // Genau EIN Memo-Helper pro Modul (CLAUDE.md „Memo-Pattern"); Speicher
  // `_memos` lebt pro Karten-Instanz und wird in resetDrafts/loadArc geleert.
  ...memoMethods,
  ...vorschlaegeMethods,
  ...contextMenuMethods,
  ...historyMethods,
  ...mindmapViewMethods,
};

export { resolveTopic, resolveMindmapForDisplay };

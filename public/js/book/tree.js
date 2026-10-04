// Buch-/Seiten-Tree-Methoden — Facade über book/tree/. Werden in die Alpine-Root-
// Komponente gespreadet (app.js); `this` bezieht sich dort auf die Komponente.
//
// Interne Aufteilung (Submodule):
//   tree/load.js        — Buch-/Seiten-Laden, Combobox, Kapitel-Anlage,
//                         Token-Estimate-Backfill. Exportiert auch `insertChapterItem`.
//   tree/build.js       — Tree-Aufbau aus der bookTree-Antwort (nav.pages/nav.tree +
//                         Sortier-Indexe) + Nachladen der Sidebar-Plaketten.
//   tree/catchup.js     — leiser Nachzug des Baums (SW-Revalidierung, Collab-Feed,
//                         Drift-Probe) — die zweite Haelfte von Stale-While-Revalidate.
//   tree/permissions.js — ACL-Rolle + Entity-Flag pro Buch, canEdit/canReview/isViewer, Buchtyp.
//   tree/open-state.js  — Persistenter Collapse-State + Chapter-Header-Aktivierung.
//   tree/stats.js       — Seiten-Status/Tooltips, Page-Stats-Sync, Kapitel-Aggregation.
//   tree/ui.js          — Sidebar-Tooltip-Helper (Token-Badge + Page-Status).
//   tree/keyboard.js    — Tastatur-/Fokus-Fuehrung (ARIA-Tree, ein Tab-Stopp) +
//                         Aufdecken der geoeffneten Seite.

import { treeLoadMethods } from './tree/load.js';
import { treeBuildMethods } from './tree/build.js';
import { treeCatchUpMethods } from './tree/catchup.js';
import { treePermissionsMethods } from './tree/permissions.js';
import { treeOpenStateMethods } from './tree/open-state.js';
import { treeStatsMethods } from './tree/stats.js';
import { treeUiMethods } from './tree/ui.js';
import { treeKeyboardMethods } from './tree/keyboard.js';


export const treeMethods = {
  ...treeLoadMethods,
  ...treeBuildMethods,
  ...treeCatchUpMethods,
  ...treePermissionsMethods,
  ...treeOpenStateMethods,
  ...treeStatsMethods,
  ...treeUiMethods,
  ...treeKeyboardMethods,
};

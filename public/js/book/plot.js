// Facade: Methoden der Plot-Werkstatt (Beat-Board), kombiniert nach Domäne.
// Planendes Welt-/Plot-Werkzeug: Akte (Spalten) + Beats (Karten) pro Buch + User,
// optionale Handlungsstränge als Swimlanes. CRUD, 2D-Drag-&-Drop-Reordering und
// zwei KI-Jobs (Brainstorm + Consistency) — die KI plant/prüft nur die Struktur,
// schreibt nie Fliesstext ins Manuskript.
//
// Sub-Module (gemeinsamer this._memos-Speicher pro Card-Instanz, _memo aus
// lifecycle.js):
//   - constants.js — STATUSES, ACT_PALETTE, Spannungs-Mapping (geteilt)
//   - lifecycle.js — Board laden/reset + Memo-Helper
//   - derived.js   — abgeleitete Reads: Beats/Stats, Stränge, Grid, Spannungsbogen, Filter
//   - acts.js      — Akt-CRUD, Reihenfolge, Farbe, scoped Anlegen, Hybrid-Fork
//   - threads.js   — Strang-CRUD (Swimlanes)
//   - beats.js     — Beat-CRUD (flach + grid-zellen) + Drop-Mechanik (_dropBeat)
//   - dnd.js       — SortableJS-Anbindung (Init/Reattach/Revert → _dropBeat)
//   - history.js   — Undo/Redo (max 10 Schritte) über alle reversiblen Mutationen
//   - ai.js        — KI-Jobs (Brainstorm/Consistency), Lauf-Historie, Fullscreen
//   - time-check.js — Zeit-Messung (deterministisch, GET /plot/time-check)
//   - zeit.js      — erzählte Zeit am Beat: verstanden als, Befund-Marker, Vorschläge aus dem Text
//   - beat-move.js — Beat verschieben ohne Drag (Akt/Strang/oben-unten → _dropBeat)
//   - board-ui.js  — Dichte-Modus, Akte einklappen, Menü-Tastatur, Leer-Zustand
//   - konflikt-actions.js — Befund-Typen, Typ-Filter, Ein-Klick-Aktionen
//   - utils/befund-severity.js — Schwere → Plaketten-Klasse (Befund-Skala)

import { lifecycleMethods } from './plot/lifecycle.js';
import { derivedMethods } from './plot/derived.js';
import { actsMethods } from './plot/acts.js';
import { threadsMethods } from './plot/threads.js';
import { beatsMethods } from './plot/beats.js';
import { dndMethods } from './plot/dnd.js';
import { historyMethods } from './plot/history.js';
import { aiMethods } from './plot/ai.js';
import { timeCheckMethods } from './plot/time-check.js';
import { zeitMethods } from './plot/zeit.js';
import { beatMoveMethods } from './plot/beat-move.js';
import { boardUiMethods } from './plot/board-ui.js';
import { konfliktActionMethods } from './plot/konflikt-actions.js';
import { befundSeverityMethods } from '../utils/befund-severity.js';

export const plotMethods = {
  ...lifecycleMethods,
  ...derivedMethods,
  ...actsMethods,
  ...threadsMethods,
  ...beatsMethods,
  ...dndMethods,
  ...historyMethods,
  ...aiMethods,
  ...timeCheckMethods,
  ...zeitMethods,
  ...beatMoveMethods,
  ...boardUiMethods,
  ...konfliktActionMethods,
  ...befundSeverityMethods,
};

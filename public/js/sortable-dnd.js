// Geteilter SortableJS-Kern für Alpine-x-for-Boards (Buchorganizer, Plot-Werkstatt, Ideen-Board, Recherche-Status, Motive).
// Kapselt die drift-anfälligen, hart erarbeiteten Bausteine, die beide Boards
// identisch brauchen — Ziel: der nächste SortableJS-Versionssprung wird an EINER
// Stelle verifiziert, nicht in jedem Board separat.
//
// Kernspannung, gegen die diese Helfer arbeiten: SortableJS verschiebt physisch
// DOM-Nodes, Alpine x-for glaubt aber, dieselben Nodes zu besitzen. Ohne Revert →
// Orphan/Duplikat-Nodes ("double swap"). Etablierte gute Praxis (vuedraggable,
// Alpines eigenes x-sort-Plugin): Sortable bewegen lassen → Node zurücknehmen →
// Modell mutieren → x-for rendert daraus neu. revertSortable() ist dieser Schritt.
//
// Feature-spezifisches (Gruppen, Handles, Validierung im onMove, Drop-Logik,
// Grid- vs. nested-Orchestrierung, Reattach) bleibt bewusst im jeweiligen dnd.js.

// SortableJS v1.15.6-Patch: `_onDragOver` kann auf einer destroyten Instanz
// (this.el === null) feuern, wenn Alpine x-for nach einem Drop neu reconciliated.
// No-op auf null el statt zu crashen. Idempotent (mehrfacher Aufruf schadet nicht).
export function patchSortableOnce(Sortable) {
  if (!Sortable || Sortable.prototype._dragOverGuarded) return;
  const orig = Sortable.prototype._onDragOver;
  Sortable.prototype._onDragOver = function (evt) {
    if (!this.el) return;
    return orig.call(this, evt);
  };
  Sortable.prototype._dragOverGuarded = true;
}

// Draggable-Space-Index eines Elements innerhalb seines Parents — zählt exakt wie
// SortableJS' internes index() (Template-Anker übersprungen), damit Revert-Refs im
// selben Indexraum wie evt.oldIndex/newIndex liegen.
export function sortableIndexOf(el) {
  let idx = 0;
  let cur = el;
  while ((cur = cur.previousElementSibling)) {
    if (cur.tagName !== 'TEMPLATE') idx++;
  }
  return idx;
}

// Nimmt SortableJS' physischen DOM-Move zurück (Node zurück in Quell-Container an
// alten Index). Pflicht VOR jeder Modell-Mutation: sonst besitzen SortableJS und
// Alpine x-for dieselben Nodes doppelt — zeigt Alpines key→el-Map einer anderen
// x-for-Scope weiterhin auf den verschobenen Node → Orphan/Duplikat-Nodes,
// driftender DOM, falsche Positionen. Nach Revert ist Alpine alleiniger DOM-
// Besitzer; das Modell (vom Aufrufer mutiert) ist die Wahrheit, x-for rendert neu.
// Darum muss das Modell NOCH VOR dem ersten await auf dem Ziel stehen
// (optimistisch, bei Fehler zurueck): sonst zeigt das Board die Karte bis zur
// Server-Antwort wieder in der Quellzelle — sie flackert zurueck und springt
// dann ans Ziel.
export function revertSortable(evt) {
  const { item, from, oldIndex } = evt;
  if (!item || !from || !Number.isFinite(oldIndex)) return;
  // Schon am richtigen Slot? (Index im SortableJS-Raum vergleichen, nicht im rohen
  // from.children-Raum — Alpines <template x-for> ist erstes Kind und verschiebt
  // die rohe HTMLCollection um 1 gegen evt.oldIndex.)
  if (item.parentNode === from && sortableIndexOf(item) === oldIndex) return;
  // Referenz-Knoten am draggable-Slot oldIndex finden — Template (und das gezogene
  // Item selbst, falls noch in `from`) beim Zählen überspringen.
  let ref = null;
  let idx = 0;
  for (const child of from.children) {
    if (child === item || child.tagName === 'TEMPLATE') continue;
    if (idx === oldIndex) { ref = child; break; }
    idx++;
  }
  from.insertBefore(item, ref); // ref===null → ans Ende
}

// x-ignore am Drag-Item: der via cloneNode(true) erzeugte Fallback-Ghost im <body>
// wird so von Alpines MutationObserver übersprungen — sonst evaluiert Alpine
// gebundene Ausdrücke (`:value="page.name"`, `beat.*`) ausserhalb des x-for-Scopes
// und wirft "… is not defined". Nach dem Drag (onEnd) wieder entfernen.
export function markDragIgnore(evt) { evt.item?.setAttribute('x-ignore', ''); }
export function unmarkDragIgnore(evt) { evt.item?.removeAttribute('x-ignore'); }

// Präzisions-Tuning, das beide Boards teilen (gegen "Nachbar verrutscht beim
// Ziehen"-Flackern, HTML5-DnD-Browser-Quirks, Item-Loss bei Drop ausserhalb):
//   - forceFallback + fallbackOnBody: konsistenter Klon-Ghost im <body> statt
//     nativem HTML5-DnD (sprunghafter Cursor, ungenaue dragover-Targets).
//   - fallbackTolerance 5: 5px Bewegung nötig bevor Drag startet — ein reiner
//     Klick auf den Handle löst nicht versehentlich einen Drag aus.
//   - swapThreshold 0.65: Swap erst bei 65% Cursor im Ziel-Item (Default 1.0
//     swappt schon bei minimaler Überlappung → Nachbarn flackern).
//   - invertSwap: Backward-Drops (in nested/Parent-Listen) werden stabil erkannt.
//   - revertOnSpill: Drop ausserhalb gültiger Liste springt zurück statt Item-Loss.
//   - direction vertical: Sortable optimiert die Swap-Berechnung explizit.
// Pro-Board-Overrides via Spread (z.B. emptyInsertThreshold, scroll, Klassen,
// draggable, handle, group, Callbacks):
//   { ...BASE_SORTABLE_OPTS, emptyInsertThreshold: 24, scroll: true, ... }
export const BASE_SORTABLE_OPTS = Object.freeze({
  animation: 0,
  forceFallback: true,
  fallbackOnBody: true,
  fallbackTolerance: 5,
  swapThreshold: 0.65,
  invertSwap: true,
  direction: 'vertical',
  revertOnSpill: true,
});

// ── Karten-Boards (Plot-Werkstatt, Ideen-Board, Recherche-Status) ───────────
// Ein Board = Spalten/Zellen mit Karten, die per Griff zwischen Zellen wandern.
// Alle drei ziehen gleich: dieselben Sortable-Optionen (boardSortableOpts),
// derselbe Drag-Zustand (startBoardDrag/endBoardDrag) und dieselbe Optik aus
// components/board-dnd.css. Das Board liefert nur Geometrie und Drop-Logik:
// Zellen tragen `.board-dnd-zone`, Karten setzen `--board-dnd-accent` (Rahmen
// von Platzhalter und Drop-Zone) und `--board-dnd-clone-accent` (Rahmen des
// Klons im <body>, muss ohne Spalten-Kontext aufloesen).
export const BOARD_DND_ACTIVE = 'board-dnd-active';

// Drag-Zustand. onStart/onEnd statt onChoose/onUnchoose: ein reiner Klick
// toggelt nichts.
// * `board-dnd-active` an <body> → leere Zellen werden zur Drop-Zone.
// * `--sortable-drag-h` an <body> = Hoehe der gezogenen Karte; die Drop-Zone
//   ist so hoch wie das Gezogene (gedeckelt, board-dnd.css).
// * Der Platzhalter (evt.item mit ghostClass) behaelt diese Hoehe. Er wandert in
//   die Zielzelle, und ist die schmaler als die Quelle (Ideen-Board: Stufen ohne
//   Karte sind schmale Spalten), braeche sein unsichtbarer Inhalt dort auf viele
//   Zeilen um — die ganze Bahn wuerde mitten im Drag mehrfach so hoch. Und eine
//   Zielzelle schrumpft nie unter die Kartenhoehe, sobald der Platzhalter
//   eindringt (sonst fiele der Zeiger aus der Trefferzone, die Karte spraenge
//   beim Loslassen zurueck).
// * Im Native-Vollbild rendert nur der Teilbaum des Fullscreen-Elements;
//   SortableJS haengt den Fallback-Klon aber an <body>, also unsichtbar hinter
//   das Vollbild. Darum den Klon (`Sortable.ghost`, existiert ab onStart) ins
//   Fullscreen-Element umhaengen; `position: fixed` bleibt viewport-relativ, und
//   SortableJS raeumt ihn ueber `parentNode` auf.
export function startBoardDrag(Sortable, evt) {
  document.body.classList.add(BOARD_DND_ACTIVE);
  const item = evt?.item;
  const h = item ? Math.round(item.getBoundingClientRect().height) : 0;
  if (h > 0) {
    document.body.style.setProperty('--sortable-drag-h', `${h}px`);
    item.style.height = `${h}px`;
    item.style.overflow = 'hidden';
  }
  const fsEl = document.fullscreenElement;
  const ghost = Sortable?.ghost;
  if (fsEl && ghost && !fsEl.contains(ghost)) fsEl.appendChild(ghost);
}

// Gegenstueck zu startBoardDrag; auch beim Teardown aufrufen (ohne evt), damit
// ein unterbrochener Drag keine aufgeblaehten Zellen stehen laesst.
export function endBoardDrag(evt) {
  document.body.classList.remove(BOARD_DND_ACTIVE);
  document.body.style.removeProperty('--sortable-drag-h');
  evt?.item?.style.removeProperty('height');
  evt?.item?.style.removeProperty('overflow');
}

// Sortable-Optionen eines Karten-Boards. Das Board gibt `draggable`, `handle`,
// `group` und seine Drop-Logik (`onEnd`) mit; `onStart` fuer Zusatzarbeit beim
// Drag-Start. Weitere Overrides (z.B. `emptyInsertThreshold`, `sort`) gehen per
// Spread durch und brauchen eine Begruendung am Aufrufer.
// * emptyInsertThreshold 24: grosszuegiger Trefferradius um jede leere Zelle —
//   ein schneller Zug ueber mehrere Zellen faengt im Ziel statt im Spalten-Gap.
// * invertSwap false: Board-Zellen sind flache Listen, keine verschachtelten.
//   Der invertierte Swap-Bereich liesse die obere von zwei Karten nicht unter
//   die untere ziehen — bei zwei Karten der einzige moegliche Zug.
export function boardSortableOpts(Sortable, { onStart, onEnd, ...opts }) {
  return {
    ...BASE_SORTABLE_OPTS,
    invertSwap: false,
    emptyInsertThreshold: 24,
    scroll: true,
    chosenClass: 'board-dnd-chosen',
    ghostClass: 'board-dnd-ghost',
    dragClass: 'board-dnd-dragging',
    onChoose: markDragIgnore,
    onUnchoose: unmarkDragIgnore,
    ...opts,
    onStart: (evt) => { startBoardDrag(Sortable, evt); onStart?.(evt); },
    onEnd: (evt) => { endBoardDrag(evt); unmarkDragIgnore(evt); onEnd?.(evt); },
  };
}

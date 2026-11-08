// Plot-Werkstatt: Drag-&-Drop via SortableJS (statt nativem HTML5-DnD).
// Spiegelt das Buchorganizer-Muster ([public/js/book-organizer/dnd.js]):
// SortableJS bindet pro Beat-Zelle (Akt × Strang) einen Container, alle teilen die
// `plot-beats`-Gruppe → Beats wandern per Drag zwischen Zellen. Vor jeder Modell-
// Mutation wird SortableJS' physischer DOM-Move zurückgenommen (revertSortable),
// damit Alpine x-for alleiniger DOM-Besitzer bleibt; die geprüfte _dropBeat-Logik
// (beats.js) mutiert dann das Modell und x-for rendert neu. Der Ghost-Slot zeigt
// dem User vor dem Loslassen exakt, wo die Karte landet.
//
// Geteilter SortableJS-Kern (Patch, Revert, Tuning, x-ignore) liegt in
// [public/js/sortable-dnd.js] — beim Sortable-Bump dort verifizieren.

import {
  patchSortableOnce,
  revertSortable,
  boardSortableOpts,
  endBoardDrag,
} from '../../sortable-dnd.js';

export const dndMethods = {
  _destroySortables() {
    for (const s of (this._sortables || [])) { try { s.destroy(); } catch {} }
    this._sortables = [];
    // Falls ein Drag durch Reattach/Teardown unterbrochen wurde, Drag-Klasse +
    // gemessene Karten-Höhe nicht permanent stehen lassen (sonst bleiben leere
    // Zellen aufgebläht bzw. auf einer veralteten Höhe).
    endBoardDrag();
  },

  // Reattach coalescen: strukturelle Änderungen (Akt-/Strang-CRUD, Fork, loadBoard)
  // feuern oft mehrfach pro Frame über $watch. Ein nextTick-Durchlauf reicht.
  _scheduleReattach() {
    if (this._reattachQueued) return;
    this._reattachQueued = true;
    this.$nextTick(() => { this._reattachQueued = false; this._reattachSortables(); });
  },

  // Sortable-Instanzen frisch ans aktuelle DOM binden. gridRows()/acts/threads
  // ändern die Zell-Container (x-for erzeugt neue Elemente) — alte Refs zeigen
  // sonst auf stale Nodes und folgende Drops verschieben Beats in unsichtbaren
  // alten Zellen.
  async _reattachSortables() {
    this._destroySortables();
    await this.$nextTick();
    this._initSortables();
  },

  _initSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroySortables();
    // Karten-Board-Optionen + Drag-Zustand aus sortable-dnd.js#boardSortableOpts
    // (gleich in Plot, Ideen-Board, Recherche-Status). `handle` = der Drag-Griff
    // (.plot-beat-grip, nur im Ansichtsmodus gerendert): einzige Greiffläche, so
    // dass die übrige Karte voll klickbar bleibt (Status zyklen, Titel→Edit,
    // Tags→Figur springen). Kein `filter` nötig — der Griff fehlt im Edit-Modus,
    // ein bearbeiteter Beat ist also nie ziehbar.
    const baseOpts = boardSortableOpts(Sortable, {
      draggable: '.plot-beat',
      handle: '.plot-beat-grip',
      group: { name: 'plot-beats', pull: true, put: ['plot-beats'] },
      onEnd: (evt) => this.onBeatSortEnd(evt),
    });
    // Eine Sortable-Instanz pro Beat-Zelle (.plot-beats[data-plot-cell]). Flaches
    // Board und Grid sind beide im DOM (x-show); die jeweils versteckten Container
    // sind geometrielos → nie Drop-Ziel, das Binden bleibt unschädlich.
    const cells = this.$root.querySelectorAll('[data-plot-cell]');
    for (const el of cells) this._sortables.push(new Sortable(el, baseOpts));
  },

  // ID der Beat-Karte, vor der eingefügt wird = nächste .plot-beat-Geschwisterkarte
  // am neuen Slot. null = ans Zell-Ende. VOR dem Revert lesen (danach ist der Knoten
  // zurück in der Quelle). Der Container hält ausser dem <template>-Anker nur Beats.
  _nextBeatId(item) {
    let cur = item?.nextElementSibling;
    while (cur) {
      if (cur.classList?.contains('plot-beat') && cur.dataset?.beatId) {
        return parseInt(cur.dataset.beatId, 10);
      }
      cur = cur.nextElementSibling;
    }
    return null;
  },

  // SortableJS onEnd → Brücke auf die bewährte _dropBeat-Mechanik (beats.js).
  async onBeatSortEnd(evt) {
    const item = evt.item;
    const toEl = evt.to;
    const beatId = parseInt(item?.dataset?.beatId, 10);
    if (this.busy || !Number.isFinite(beatId)) { revertSortable(evt); return; }
    // Echter No-op (gleiche Zelle, gleiche Position) → SortableJS hat nichts bewegt.
    if (evt.from === toEl && evt.oldIndex === evt.newIndex) return;
    const actId = parseInt(toEl?.dataset?.actId, 10);
    if (!Number.isFinite(actId)) { revertSortable(evt); return; }
    const rawThread = toEl?.dataset?.threadId;
    const threadId = (rawThread == null || rawThread === '') ? null : (parseInt(rawThread, 10) || null);
    const beforeBeatId = this._nextBeatId(item);
    revertSortable(evt);
    this._dragBeatId = beatId;
    await this._dropBeat(actId, threadId, beforeBeatId);
  },
};

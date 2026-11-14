// Plot-Werkstatt: Aktionsmenü für Beat, Akt und Strang — EINE teleportierte
// Instanz je Karte (action-menu.js, plot-actions-menu.html). Schlüssel
// `beat:<id>` / `act:<id>` / `thread:<laneId>`, Ziel `{ ctx, id }`; das Menü
// löst das Objekt live auf (ein Board-Reload tauscht die Objekte aus).
//
// Kein Menü, solange das Element im Bearbeiten-Modus ist: dort bleibt der
// native Rechtsklick des Textfelds (kein preventDefault → Browser-Menü).

export const plotMenuMethods = {
  _plotMenuId(ctx) {
    const t = this.actionMenuTarget;
    return t && t.ctx === ctx ? t.id : null;
  },

  openBeatMenu(ev, beat) {
    if (!beat || this.editingBeatId === beat.id) return;
    this.openActionMenu(ev, `beat:${beat.id}`, { ctx: 'beat', id: beat.id });
  },
  beatMenuBeat() {
    const id = this._plotMenuId('beat');
    return id == null ? null : (this.beats || []).find(b => b.id === id) || null;
  },

  openActMenu(ev, act) {
    if (!act || this.editingActId === act.id) return;
    this.openActionMenu(ev, `act:${act.id}`, { ctx: 'act', id: act.id });
  },
  actMenuAct() {
    const id = this._plotMenuId('act');
    return id == null ? null : (this.acts || []).find(a => a.id === id) || null;
  },

  // Strang-Lane (⋯-Knopf, Rechtsklick/Long-Press auf den Lane-Kopf). Die Lane
  // sitzt in einem overflow-x/will-change-Scrollcontainer, in dem ein am
  // Trigger verankertes Popover geclippt würde — darum das teleportierte Menü.
  openThreadMenu(ev, laneId) {
    if (laneId == null || this.editingThreadId === laneId) return;
    this.openActionMenu(ev, `thread:${laneId}`, { ctx: 'thread', id: laneId });
  },
  // Die offene Lane (für das teleportierte Menü außerhalb der gridRows-Schleife).
  threadMenuLane() {
    const id = this._plotMenuId('thread');
    if (id == null) return null;
    return (this.threadLanes() || []).find(l => l.id === id) || null;
  },

  // Brainstorm aus dem Akt-Menü: im flachen Board pro Akt, im Grid pro Zelle
  // (dort steht der Knopf an der Zelle) — das Menü bietet den Akt-Lauf nur
  // im flachen Board an.
  canBrainstormAct(act) {
    return !!act && !act.archiviert && !this.threads.length && !this.brainstormLoading;
  },
};

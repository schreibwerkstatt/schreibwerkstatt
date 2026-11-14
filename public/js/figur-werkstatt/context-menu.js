// Rechtsklick-/Long-Press-Menü auf Mindmap-Knoten: Brainstorm/Rename/AddChild/AddSibling/Delete,
// und auf Einträgen der Figurenliste (⋯, Rechtsklick, Long-Press): Konsistenz-Check, Löschen.
// Die Aktionen lesen das Ziel synchron vorne (das Menue schliesst nach dem Eintrag und leert es).

export const contextMenuMethods = {
  // Rechtsklick auf einen Knoten (Long-Press loest via `x-long-press` am
  // Container ebenfalls `contextmenu` aus). Mechanik aus action-menu.js,
  // Ziel = Knoten-ID.
  _onMindmapContextMenu(ev) {
    const target = ev.target.closest?.('jmnode');
    const nodeId = target?.getAttribute('nodeid');
    if (!nodeId) { this.closeActionMenu(); return; }
    this._selectNodeQuiet(nodeId);
    this.selectedKnotenId = nodeId;
    this.openActionMenu(ev, `mindmap:${nodeId}`, nodeId);
  },

  ctxRename() {
    const id = this.actionMenuTarget;
    if (!id || !this._jm) return;
    try { this._jm.begin_edit(id); } catch {}
  },

  // Gleicher Weg wie Tab/Enter (mindmap.js#_addNodeAt).
  ctxAddChild() {
    this._addNodeAt(this.actionMenuTarget, 'child');
  },

  ctxAddSibling() {
    this._addNodeAt(this.actionMenuTarget, 'sibling');
  },

  // Gleicher Weg wie die Entf-Taste: Kerne gesperrt, Teilbaum mit Rückfrage
  // (history.js#_requestDeleteNode).
  ctxDelete() {
    const id = this.actionMenuTarget;
    this._requestDeleteNode(id);
  },

  // Figurenliste: Ziel = Draft-ID, aufgelöst über menuDraft() (live).
  openDraftMenu(ev, d) {
    if (!d) return;
    this.openActionMenu(ev, `draft:${d.id}`, d.id);
  },

  menuDraft() {
    if (!this.actionMenuKey?.startsWith('draft:')) return null;
    return this.drafts.find(d => d.id === this.actionMenuTarget) || null;
  },

  // Der Check läuft auf der ausgewählten Figur: erst wechseln (mit Auto-Save
  // wie beim Klick in die Liste), dann starten.
  async draftMenuConsistency() {
    const id = this.actionMenuTarget;
    if (!id) return;
    if (this.selectedDraftId !== id) await this.selectDraft(id);
    if (this.selectedDraftId === id) this.runConsistency();
  },

  draftMenuDelete() {
    const id = this.actionMenuTarget;
    if (id) this.requestDelete(id);
  },

  ctxBrainstorm() {
    if (this.brainstormLoading) return;
    this.runBrainstorm();
  },
};

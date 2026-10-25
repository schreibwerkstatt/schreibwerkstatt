// Rechtsklick-/Long-Press-Menü auf Mindmap-Knoten: Brainstorm/Rename/AddChild/AddSibling/Delete.
// Die Aktionen lesen das Ziel vor dem Schliessen (closeActionMenu leert es).

import { _newNodeId } from './mindmap.js';

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
    this.closeActionMenu();
    if (!id || !this._jm) return;
    try { this._jm.begin_edit(id); } catch {}
  },

  ctxAddChild() {
    const id = this.actionMenuTarget;
    this.closeActionMenu();
    if (!id) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.newNode');
    this._mutateMindmapQuiet(jm => {
      jm.add_node(id, newId, label);
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  ctxAddSibling() {
    const id = this.actionMenuTarget;
    this.closeActionMenu();
    if (!id) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.newNode');
    this._mutateMindmapQuiet(jm => {
      jm.insert_node_after(id, newId, label);
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  // Gleicher Weg wie die Entf-Taste: Kerne gesperrt, Teilbaum mit Rückfrage
  // (history.js#_requestDeleteNode).
  ctxDelete() {
    const id = this.actionMenuTarget;
    this.closeActionMenu();
    this._requestDeleteNode(id);
  },

  ctxBrainstorm() {
    this.closeActionMenu();
    if (this.brainstormLoading) return;
    this.runBrainstorm();
  },
};

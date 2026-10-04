// Rechtsklick-/Long-Press-Menü auf Mindmap-Knoten: Brainstorm/Rename/AddChild/AddSibling/Delete.

import { _newNodeId } from './mindmap.js';

export const contextMenuMethods = {
  _onMindmapContextMenu(ev) {
    this._cancelLongPress?.();
    const target = ev.target.closest?.('jmnode');
    if (!target) { this._hideContextMenu(); return; }
    if (!target.getAttribute('nodeid')) return;
    ev.preventDefault();
    this._openNodeMenu(target, ev.clientX, ev.clientY);
  },

  // Gemeinsamer Einstieg fuer Rechtsklick und Long-Press (mindmap.js).
  _openNodeMenu(target, x, y) {
    const nodeId = target.getAttribute('nodeid');
    if (!nodeId) return;
    this._selectNodeQuiet(nodeId);
    this.selectedKnotenId = nodeId;
    this.contextMenuNodeId = nodeId;
    this.contextMenuPos = this._clampMenuPos(x, y);
    this.contextMenuOpen = true;
    if (!this._ctxOutsideHandler) {
      this._ctxOutsideHandler = (e) => {
        const menu = this.$el?.querySelector('.werkstatt-context-menu');
        if (menu && !menu.contains(e.target)) this._hideContextMenu();
      };
      document.addEventListener('mousedown', this._ctxOutsideHandler, true);
      document.addEventListener('keydown', this._ctxEscHandler = (e) => {
        if (e.key === 'Escape') this._hideContextMenu();
      });
    }
  },

  // Cursor-verankert, viewport-bezogen: das Menü ist `position: fixed`, und
  // weder `.card` (cardFadeIn läuft mit `backwards`, kein Transform bleibt
  // stehen — public/CLAUDE.md) noch das Vollbild-Element `.werkstatt-detail`
  // etabliert einen Containing-Block. clientX/Y gelten darum unverändert.
  // Geklemmt auf beide Viewport-Ränder: unten/rechts, damit das Menü nicht
  // hinausragt, oben/links, damit es auf schmalen Viewports nicht negativ wird.
  _clampMenuPos(x, y) {
    const W = 240, H = 240, M = 8;
    return {
      left: Math.max(M, Math.min(window.innerWidth - W - M, x)),
      top: Math.max(M, Math.min(window.innerHeight - H - M, y)),
    };
  },

  _hideContextMenu() {
    this.contextMenuOpen = false;
    this.contextMenuNodeId = null;
    if (this._ctxOutsideHandler) {
      document.removeEventListener('mousedown', this._ctxOutsideHandler, true);
      this._ctxOutsideHandler = null;
    }
    if (this._ctxEscHandler) {
      document.removeEventListener('keydown', this._ctxEscHandler);
      this._ctxEscHandler = null;
    }
  },

  ctxRename() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    try { this._jm.begin_edit(id); } catch {}
  },

  ctxAddChild() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
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
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.newNode');
    this._mutateMindmapQuiet(jm => {
      jm.insert_node_after(id, newId, label);
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  ctxDelete() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || id === 'root') return;
    this._mutateMindmap(jm => jm.remove_node(id));
  },

  ctxBrainstorm() {
    this._hideContextMenu();
    if (this.brainstormLoading) return;
    this.runBrainstorm();
  },
};

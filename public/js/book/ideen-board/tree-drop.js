// Drop einer Buch-Idee aus dem Ideen-Board auf einen Eintrag im
// Inhaltsverzeichnis der Sidebar. Gespreadet in ideenBoardActions
// (actions.js); `this` = die ideenBoardCard-Instanz.
//
// Das Board zeigt nur belegte Bahnen; ein Kapitel oder Abschnitt ohne Ideen
// ist dort kein Ziel. Die Sidebar fuehrt dagegen jeden Anker. Sortable kennt
// den Baum nicht (ein Drop dort ist ein Spill, revertOnSpill) — darum wird
// waehrend des Drags der Baumeintrag unter dem Zeiger gemerkt und markiert.
// Der Fallback-Klon hat `pointer-events: none`, `elementFromPoint` trifft
// also, was darunter liegt.

export const ideenBoardTreeDrop = {
  _trackTreeDrop() {
    this._stopTreeDrop();
    document.body.classList.add('ideen-tree-drop-active');
    const onMove = (e) => {
      const p = e.touches?.[0] || e;
      const el = document.elementFromPoint(p.clientX, p.clientY)
        ?.closest('.page-tree [data-tree-kind="chapter"], .page-tree [data-tree-kind="page"]');
      if (el === this._treeDropEl) return;
      this._treeDropEl?.classList.remove('tree-drop-target');
      this._treeDropEl = el || null;
      const key = el?.dataset?.treeKey || '';
      const id = parseInt(key.slice(1), 10);
      this._treeDropLane = el && id ? `${key[0] === 'c' ? 'chapter' : 'page'}:${id}` : '';
      el?.classList.add('tree-drop-target');
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    this._treeDropOff = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('touchmove', onMove);
    };
  },

  _stopTreeDrop() {
    this._treeDropOff?.();
    this._treeDropOff = null;
    document.body.classList.remove('ideen-tree-drop-active');
    this._treeDropEl?.classList.remove('tree-drop-target');
    this._treeDropEl = null;
    this._treeDropLane = '';
  },
};

// Rückgängig/Wiederholen der Mindmap und das geschützte Löschen von Knoten.
//
// jsMind hat keinen eigenen Undo-Stack. Der Kern hier ist ein Snapshot-Stack
// über `get_data('node_tree')`: jede Mutation (Tastatur in jsMind, Kontextmenü,
// Brainstorm-Apply) läuft durch _markMindmapDirty und damit durch
// _recordMindmapStep — der Stand VOR der Änderung ist der zuletzt gemerkte
// (`_mmLast`), er wandert auf den Undo-Stack. So braucht keine Mutation einen
// eigenen Vorher-Snapshot. Der Text-Undo der Editoren (editor/shared/
// edit-history.js) passt nicht: er arbeitet auf contenteditable-HTML.
//
// Löschen geht über _requestDeleteNode (Entf-Taste und Kontextmenü): die
// psychologischen Kerne und ihre Container sind gesperrt, ein Teilbaum fragt
// vorher nach. Warum gesperrt: Bogen-Band, Verankerung, Plot-Kontext und die
// Konsistenzprüfung erkennen die Kerne an ihrer festen Knoten-ID
// (lib/draft-mindmap-extract.js). Ein gelöschter und neu angelegter „Want"-
// Knoten hätte eine Zufalls-ID — die Figur fiele still aus allen vier heraus.

const MAX_STEPS = 100;

// Feste IDs aus lib/draft-mindmap-default.js, an denen Kern-Funktionen hängen:
// die sechs Kerne (PSYCHE_KERNE in lib/draft-mindmap-extract.js) und ihre
// Container. Umbenennen bleibt erlaubt — die ID trägt, nicht das Topic.
const PROTECTED_NODE_IDS = new Set([
  'steckbrief', 'subtext',
  'bogen', 'konflikt', 'want', 'need', 'wound', 'lie',
]);

function _snapshot(jm) {
  try {
    const d = jm.get_data('node_tree');
    return d?.data ? JSON.stringify(d) : null;
  } catch { return null; }
}

function _containsProtected(node) {
  if (!node) return false;
  if (PROTECTED_NODE_IDS.has(node.id)) return true;
  return (node.children || []).some(_containsProtected);
}

function _countDescendants(node) {
  return (node?.children || []).reduce((n, c) => n + 1 + _countDescendants(c), 0);
}

export const historyMethods = {
  // Nach jedem Mount: Stapel leer, Ausgangsstand merken.
  _resetMindmapHistory() {
    this._mmUndo = [];
    this._mmRedo = [];
    this._mmLast = this._jm ? _snapshot(this._jm) : null;
  },

  _clearMindmapHistory() {
    this._mmUndo = [];
    this._mmRedo = [];
    this._mmLast = null;
  },

  // Aus _markMindmapDirty: Vorher-Stand auf den Stapel, wenn sich wirklich
  // etwas geändert hat (programmatisches add_node feuert mal ein Edit-Event,
  // mal nicht — der Inhaltsvergleich macht beides zu genau einem Schritt).
  _recordMindmapStep() {
    if (this._mmRestoring || !this._jm) return;
    const now = _snapshot(this._jm);
    if (!now || now === this._mmLast) return;
    if (this._mmLast) {
      this._mmUndo.push(this._mmLast);
      if (this._mmUndo.length > MAX_STEPS) this._mmUndo.shift();
    }
    this._mmRedo = [];
    this._mmLast = now;
  },

  canUndoMindmap() { return !!this._jm && this._mmUndo.length > 0; },
  canRedoMindmap() { return !!this._jm && this._mmRedo.length > 0; },

  undoMindmap() {
    if (!this.canUndoMindmap()) return;
    this._mmRedo.push(this._mmLast);
    this._restoreMindmap(this._mmUndo.pop());
  },

  redoMindmap() {
    if (!this.canRedoMindmap()) return;
    this._mmUndo.push(this._mmLast);
    this._restoreMindmap(this._mmRedo.pop());
  },

  // Stand neu zeigen. Zählt als Änderung (Generation hoch → dirty), aber nicht
  // als neuer Schritt. Die Wurzel IST die Figur: ihr Topic geht zurück ins
  // Namensfeld, sonst schriebe _syncRootTopic den neueren Namen wieder hinein.
  _restoreMindmap(snap) {
    if (!snap || !this._jm) return;
    const selected = this.selectedKnotenId;
    this._mmRestoring = true;
    try {
      this._jm.show(JSON.parse(snap));
      this._mmLast = snap;
      this._markMindmapDirty();
      const root = this._jm.get_root?.();
      if (root?.topic && root.topic !== (this.editName || '').trim()) this.editName = root.topic;
      const keep = selected && this._jm.get_node(selected) ? selected : root?.id;
      if (keep) { this._selectNodeQuiet(keep); this.selectedKnotenId = keep; }
    } catch {
      this.errorMessage = window.__app.t('werkstatt.error.applyFailed');
    } finally {
      this._mmRestoring = false;
    }
  },

  // Gemeinsamer Lösch-Einstieg für Entf-Taste und Kontextmenü.
  async _requestDeleteNode(id) {
    const app = window.__app;
    const node = id && this._jm?.get_node?.(id);
    if (!node || node.isroot) return;
    if (_containsProtected(node)) {
      this.errorMessage = app.t('werkstatt.error.nodeProtected', { name: node.topic });
      return;
    }
    const n = _countDescendants(node);
    if (n > 0) {
      const draftId = this._jmDraftId;
      const ok = await app.appConfirm({
        message: app.t('werkstatt.confirmDeleteNode', { name: node.topic, n }),
        danger: true,
      });
      // Während der Rückfrage kann die Figur gewechselt haben.
      if (!ok || this._jmDraftId !== draftId || !this._jm?.get_node?.(id)) return;
    }
    const parentId = node.parent?.id;
    this._mutateMindmap(jm => {
      if (parentId) jm.select_node(parentId);
      jm.remove_node(id);
    });
  },

  // Für den Löschen-Eintrag im Kontextmenü: Wurzel und Teilbäume mit einem
  // Kern sind nicht löschbar (gleiche Regel wie _requestDeleteNode).
  canDeleteNode(id) {
    const node = id && this._jm?.get_node?.(id);
    return !!node && !node.isroot && !_containsProtected(node);
  },
};

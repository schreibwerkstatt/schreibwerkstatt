// Alpine.data('editorFindCard') — Sub-Komponente für Find & Replace im Edit-Mode.
//
// Eigener State: findOpen, findTerm, findReplace, findCaseSensitive,
//   findWholeWord, findMatches, findIndex, findX, findY, _findRecomputeTimer,
//   _findReflowDetach.
// Root behält: editMode, focusActive, selectedBookId, setStatus(), t(),
//   _markEditDirty(). Zugriff via window.__app / $app.

import { editorFindCardMethods } from '../editor/find.js';
import { EVT } from '../events.js';

export function registerEditorFindCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFindCard', () => ({
    findOpen: false,
    findTerm: '',
    findReplace: '',
    findCaseSensitive: false,
    findWholeWord: false,
    findMatches: [],
    findIndex: -1,
    findX: 0,
    findY: 0,
    _findRecomputeTimer: null,
    _findReflowDetach: null,
    _findAbort: null,

    init() {
      const abort = new AbortController();
      this._findAbort = abort;
      const { signal } = abort;

      // Ctrl/Cmd+F: im Edit-Mode Finder öffnen, im Bucheditor dessen buchweite
      // Suche triggern (Event an die Sub), sonst Browser-Suche.
      // Bewusst im Sub statt auf dem Body-Keydown: hält die Logik beim Feature.
      window.addEventListener('keydown', (event) => {
        const isFind = (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'f' || event.key === 'F');
        if (!isFind) return;
        const app = window.__app;
        if (!app) return;
        if (app.editMode && !app.focusActive) {
          event.preventDefault();
          this.openFind();
        } else if (app.showBookEditorCard) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(EVT.BOOK_EDITOR_OPEN_FIND));
        }
      }, { signal });

      // Find-Widget muss bei Buchwechsel/View-Reset geschlossen werden, sonst
      // bleibt der capture-phase Scroll-Listener am Window kleben (per Sub-
      // mount akkumuliert).
      window.addEventListener(EVT.BOOK_CHANGED, () => this.closeFind?.(), { signal });
      window.addEventListener(EVT.VIEW_RESET,   () => this.closeFind?.(), { signal });
    },

    destroy() {
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
      if (this._findReflowDetach) { this._findReflowDetach(); this._findReflowDetach = null; }
      this._findAbort?.abort();
    },

    ...editorFindCardMethods,
  }));
}

// Alpine.data('editorSynonymeCard') — Sub-Komponente für das Synonym-
// Kontextmenü und den Picker (Rechtsklick auf Wort im Edit-Mode).
//
// Eigener State: showSynonymMenu, synonymMenuX/Y, showSynonymPicker,
//   synonymThesList/Loading/Error/Disabled, synonymKiList/Loading/Error,
//   _synonymRange, _synonymWord, _synonymPollTimer, _synonymReflowDetach,
//   _synonymJobId, _synonymReqSeq/_synonymFetchAbort (veraltete Antworten
//   verwerfen), _synonymSentenceStart (Schreibung beim Ersetzen).
// Root behält: `_onEditContextMenu` (Trigger am contenteditable extrahiert
//   Range+Word und dispatcht `editor:synonym:open {range, word, x, y}`),
//   Trampoline `closeSynonymMenu/closeSynonymPicker` und `requestSynonyms`
//   dispatchen an die Sub. `_startPoll` bleibt Root-Utility.

import { synonymCardMethods } from '../editor/synonyme.js';
import { EVT } from '../events.js';

export function registerEditorSynonymeCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorSynonymeCard', () => ({
    showSynonymMenu: false,
    synonymMenuX: 0,
    synonymMenuY: 0,
    showSynonymPicker: false,
    synonymThesList: [],
    synonymThesLoading: false,
    synonymThesError: '',
    synonymThesDisabled: false,
    synonymKiList: [],
    synonymKiLoading: false,
    synonymKiError: '',
    _synonymRange: null,
    _synonymWord: '',
    _synonymPollTimer: null,
    _synonymReflowDetach: null,
    _synonymJobId: null,
    _synonymReqSeq: 0,
    _synonymFetchAbort: null,
    _synonymSentenceStart: false,
    _synonymAbort: null,

    init() {
      const abort = new AbortController();
      this._synonymAbort = abort;
      const { signal } = abort;
      window.addEventListener(EVT.EDITOR_SYNONYM_OPEN,         (e) => this._openSynonymMenu(e.detail || {}), { signal });
      window.addEventListener(EVT.EDITOR_SYNONYM_CLOSE_MENU,   () => this.closeSynonymMenu(),               { signal });
      window.addEventListener(EVT.EDITOR_SYNONYM_CLOSE_PICKER, () => this.closeSynonymPicker(),             { signal });
      window.addEventListener(EVT.EDITOR_SYNONYM_REQUEST,      () => this.requestSynonyms(),                { signal });
    },

    destroy() {
      this._cancelSynonymRequest();
      this._detachSynonymScroll();
      this._synonymAbort?.abort();
    },

    ...synonymCardMethods,
  }));
}

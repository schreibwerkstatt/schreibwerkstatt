// editorToolbarCard: Backspace/Delete an Blockgrenzen, soweit der Keydown-
// Dispatcher (toolbar/keydown.js) sie nicht dem Browser überlässt.
// `this` = Sub-Komponente (editorToolbarCard).
//   • `_kbProtectedNeighbour` — eine Tabelle ist nie Löschziel, im Focus-Editor
//     auch kein Bild und keine Trennlinie.
//   • `_kbFocusMerge` — nur Focus-Editor: Merge zweier Geschwisterblöcke.
// Die Logik liegt framework-frei in shared/block-edge.js — dieselbe nutzt der
// Standalone-Focus-Editor der nativen Clients, die keine Toolbar laden.

import { getEditEl } from './_shared.js';
import { protectNeighbour, focusMerge } from '../../shared/block-edge.js';

export const blockEdgeMethods = {
  _kbProtectedNeighbour(e, app) {
    return protectNeighbour(e, getEditEl(), {
      atomic: !!app.focusActive,
      onChange: () => app._markEditDirty?.(),
    });
  },

  // Im Dispatcher erst nach Verlauf, Checkbox-Liste, Legende und Wrapper-
  // Grenzen — die haben eigene Handler, darum hier kein `skipSel`.
  _kbFocusMerge(e, app) {
    return focusMerge(e, getEditEl(), { onChange: () => app._markEditDirty?.() });
  },
};

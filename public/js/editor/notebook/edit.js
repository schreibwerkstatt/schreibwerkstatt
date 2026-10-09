// Facade: notebookEditMethods aus thematischen Submodulen in edit/.
// Submodul-Aufteilung nach Domäne; Methoden teilen sich zur Laufzeit ein
// gemeinsames `this` (in das Objekt gespreadet). Geteilte Imports/Konstanten
// in edit/_shared.js.
import { conflictMethods } from './edit/conflict.js';
import { lifecycleMethods } from './edit/lifecycle.js';
import { inputMethods } from './edit/input.js';
import { autosaveMethods } from './edit/autosave.js';
import { viewMethods } from './edit/view.js';
import { splitMethods } from './edit/split.js';

export const notebookEditMethods = {
  ...conflictMethods,
  ...lifecycleMethods,
  ...inputMethods,
  ...autosaveMethods,
  ...viewMethods,
  ...splitMethods,
};

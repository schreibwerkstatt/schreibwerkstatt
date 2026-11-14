// Facade: notebookEditMethods aus thematischen Submodulen in edit/.
// Submodul-Aufteilung nach Domäne; Methoden teilen sich zur Laufzeit ein
// gemeinsames `this` (in das Objekt gespreadet). Geteilte Imports/Konstanten
// in edit/_shared.js.
import { conflictMethods } from './edit/conflict.js';
import { conflictResolveMethods } from './edit/conflict-resolve.js';
import { draftReconcileMethods } from './edit/draft-reconcile.js';
import { lifecycleMethods } from './edit/lifecycle.js';
import { saveSuccessMethods } from './edit/save-success.js';
import { inputMethods } from './edit/input.js';
import { autosaveMethods } from './edit/autosave.js';
import { viewMethods } from './edit/view.js';
import { splitMethods } from './edit/split.js';
import { saveGuardMethods } from './edit/save-guard.js';

export const notebookEditMethods = {
  ...conflictMethods,
  ...conflictResolveMethods,
  ...draftReconcileMethods,
  ...lifecycleMethods,
  ...saveSuccessMethods,
  ...inputMethods,
  ...autosaveMethods,
  ...viewMethods,
  ...splitMethods,
  ...saveGuardMethods,
};

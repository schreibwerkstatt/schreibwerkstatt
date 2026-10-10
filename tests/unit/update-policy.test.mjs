// Gate für die Update-Politik der Web-Shell (public/js/app/boot/update-policy.js).
//
// WARUM ALS UNIT-TEST: Der Service Worker ist auf localhost aus
// (public/js/app/boot/sw-register.js) — ob eine neue Generation je ankommt,
// zeigt sich erst auf HTTPS, und dort nur als „bei mir ist noch die alte
// Version". Ein wartender SW wird von keinem Reload aktiviert; ohne die
// Auto-Apply-Regel bleibt, wer das Banner übersieht, beliebig lange auf dem
// alten Stand.
//
// DIE INVARIANTEN:
//   1. Wer editiert, verliert nie etwas — kein Auto-Apply bei editMode,
//      focusActive oder editDirty.
//   2. Sonst wird eingespielt, sobald der Tab im Hintergrund liegt oder lange
//      genug keine Eingabe kam.
//   3. Ein Pflicht-Update hängt nur noch an ungespeicherten Änderungen.
//   4. Server und Shell lesen den Protokoll-Stand aus DERSELBEN Datei.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AUTO_APPLY_IDLE_MS, isBusy, shouldAutoApply, isUpdateRequired, shouldForceUpdate,
} from '../../public/js/app/boot/update-policy.js';
import { SHELL_PROTOCOL } from '../../public/js/shell-protocol.js';

const require = createRequire(import.meta.url);

test('isBusy: Edit-, Fokusmodus und ungespeicherte Änderungen zählen', () => {
  assert.equal(isBusy(undefined), false);
  assert.equal(isBusy({}), false);
  assert.equal(isBusy({ editMode: true }), true);
  assert.equal(isBusy({ focusActive: true }), true);
  assert.equal(isBusy({ editDirty: true }), true);
});

test('shouldAutoApply: nie beim Editieren, nie offline', () => {
  assert.equal(shouldAutoApply({ hidden: true, idleMs: 1e9, busy: true, online: true }), false);
  assert.equal(shouldAutoApply({ hidden: true, idleMs: 1e9, busy: false, online: false }), false);
});

test('shouldAutoApply: Hintergrund-Tab oder Leerlauf', () => {
  assert.equal(shouldAutoApply({ hidden: true, idleMs: 0, busy: false, online: true }), true);
  assert.equal(shouldAutoApply({ hidden: false, idleMs: AUTO_APPLY_IDLE_MS, busy: false, online: true }), true);
  assert.equal(shouldAutoApply({ hidden: false, idleMs: AUTO_APPLY_IDLE_MS - 1, busy: false, online: true }), false);
});

test('isUpdateRequired: nur ein NEUERES Server-Protokoll erzwingt', () => {
  assert.equal(isUpdateRequired(2, 1), true);
  assert.equal(isUpdateRequired(1, 1), false);
  assert.equal(isUpdateRequired(1, 2), false);
  assert.equal(isUpdateRequired(undefined, 1), false);
  assert.equal(isUpdateRequired(null, 1), false);
});

test('shouldForceUpdate: wartet nur auf ungespeicherte Änderungen', () => {
  assert.equal(shouldForceUpdate({ dirty: false, online: true }), true);
  assert.equal(shouldForceUpdate({ dirty: true, online: true }), false);
  assert.equal(shouldForceUpdate({ dirty: false, online: false }), false);
});

test('Server meldet denselben Protokoll-Stand, den die Shell mitträgt', () => {
  const { getShellProtocol } = require('../../lib/version.js');
  assert.equal(getShellProtocol(), SHELL_PROTOCOL);
});

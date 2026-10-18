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
//   3. Ein Tab, der mit veralteter Shell gebootet hat, wartet nicht auf den
//      Leerlauf — aber auch er nie beim Editieren.
//   4. Ein Pflicht-Update hängt nur noch an ungespeicherten Änderungen — in
//      jedem Editor, auch im Bucheditor (der hat keine lokalen Entwürfe).
//   5. Server und Shell lesen den Protokoll-Stand aus DERSELBEN Datei.
//   6. Ein Tab, der beim Generationswechsel editiert hat, wird nachgeräumt,
//      sobald das Editieren endet — sonst liefert der neue SW neue Partials
//      gegen seine alten Module (ReferenceError auf neue Card-Felder).
//   7. Die Protokoll-Prüfung bleibt offen, bis ein frisches /config geantwortet
//      hat — ein gescheiterter Abruf beim neuen SW darf ein Pflicht-Update
//      nicht verschlucken; beim Aufwachen wird gedrosselt nachgefragt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AUTO_APPLY_IDLE_MS, isBusy, shouldAutoApply, shouldHealSkew, isUpdateRequired, shouldForceUpdate,
  hasUnsavedWork, registerBusySource, shouldCheckProtocol, PROTOCOL_WAKE_MIN_MS,
} from '../../public/js/app/boot/update-policy.js';
import { readFileSync } from 'node:fs';
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

test('shouldAutoApply: veraltet gebooteter Tab spielt sofort ein, ausser beim Editieren', () => {
  assert.equal(shouldAutoApply({ hidden: false, idleMs: 0, busy: false, online: true, staleBoot: true }), true);
  assert.equal(shouldAutoApply({ hidden: false, idleMs: 0, busy: true, online: true, staleBoot: true }), false);
  assert.equal(shouldAutoApply({ hidden: false, idleMs: 0, busy: false, online: false, staleBoot: true }), false);
  assert.equal(shouldAutoApply({ hidden: false, idleMs: 0, busy: false, online: true }), false);
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

test('hasUnsavedWork: Notebook/Focus dirty oder speichernd, Bucheditor über seine Quelle — Edit-Modus allein nicht', () => {
  assert.equal(hasUnsavedWork(undefined), false);
  assert.equal(hasUnsavedWork({ editMode: true, focusActive: true }), false);
  assert.equal(hasUnsavedWork({ editDirty: true }), true);
  assert.equal(hasUnsavedWork({ editSaving: true }), true);
  let blocks = true;
  const off = registerBusySource(() => blocks);
  assert.equal(hasUnsavedWork({}), true);
  blocks = false;
  assert.equal(hasUnsavedWork({}), false);
  off();
  const offThrow = registerBusySource(() => { throw new Error('tote Karte'); });
  assert.equal(hasUnsavedWork({}), false);
  offThrow();
});

test('Pflicht-Update fragt hasUnsavedWork, nicht nur editDirty', () => {
  const src = readFileSync(new URL('../../public/js/app/boot/sw-register.js', import.meta.url), 'utf8');
  assert.match(src, /shouldForceUpdate\(\{ dirty: hasUnsavedWork\(app\)/);
  assert.doesNotMatch(src, /shouldForceUpdate\(\{ dirty: !!app\?\.editDirty/);
});

test('Server meldet denselben Protokoll-Stand, den die Shell mitträgt', () => {
  const { getShellProtocol } = require('../../lib/version.js');
  assert.equal(getShellProtocol(), SHELL_PROTOCOL);
});

test('shouldHealSkew: nur ein schiefer Tab, und nie beim Editieren oder offline', () => {
  assert.equal(shouldHealSkew({ skewed: true, reloaded: false, busy: false, online: true }), true);
  assert.equal(shouldHealSkew({ skewed: false, reloaded: false, busy: false, online: true }), false);
  assert.equal(shouldHealSkew({ skewed: true, reloaded: true, busy: false, online: true }), false);
  assert.equal(shouldHealSkew({ skewed: true, reloaded: false, busy: true, online: true }), false);
  assert.equal(shouldHealSkew({ skewed: true, reloaded: false, busy: false, online: false }), false);
});

test('shouldCheckProtocol: offen wird geprüft, bis eine Antwort da ist', () => {
  assert.equal(shouldCheckProtocol({ pending: true, inflight: false, online: true }), true);
  assert.equal(shouldCheckProtocol({ pending: true, inflight: true, online: true }), false);
  assert.equal(shouldCheckProtocol({ pending: true, inflight: false, online: false }), false);
  assert.equal(shouldCheckProtocol({ pending: false, inflight: false, online: true }), false);
});

test('shouldCheckProtocol: beim Aufwachen gedrosselt', () => {
  const base = { pending: false, inflight: false, online: true, wake: true };
  assert.equal(shouldCheckProtocol({ ...base, sinceLastMs: PROTOCOL_WAKE_MIN_MS }), true);
  assert.equal(shouldCheckProtocol({ ...base, sinceLastMs: PROTOCOL_WAKE_MIN_MS - 1 }), false);
  assert.equal(shouldCheckProtocol({ ...base, online: false, sinceLastMs: Infinity }), false);
});

test('Protokoll-Marke öffnet bei updatefound und schiefem controllerchange, schliesst nur mit Antwort', () => {
  const src = readFileSync(new URL('../../public/js/app/boot/sw-register.js', import.meta.url), 'utf8');
  const updatefound = src.slice(src.indexOf("addEventListener('updatefound'"));
  assert.match(updatefound.slice(0, 600), /markProtocolPending\(\)/);
  const ctrl = src.slice(src.indexOf("addEventListener('controllerchange'"), src.indexOf('createBusyLock('));
  assert.equal((ctrl.match(/markProtocolPending\(\)/g) || []).length, 2, 'busy- und offline-Zweig');
  // Kein Einmal-Abruf mehr neben checkProtocol, und tryAutoApply prüft im Takt.
  assert.equal((src.match(/fetchJson\('\/config\?__fresh=1'\)/g) || []).length, 1);
  const tick = src.slice(src.indexOf('const tryAutoApply'), src.indexOf('setInterval(tryAutoApply'));
  assert.match(tick, /checkProtocol\(\)/);
});

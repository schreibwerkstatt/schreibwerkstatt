// tFetchErrorRaw / tErrorRaw (i18n.js): Fehlertext für einen Backend-Fehler.
// Übersetzter error_code › common.unknownError (keine Übersetzung — der rohe Code
// ist kein Satz für den User und geht nur in die Konsole) › Message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tFetchErrorRaw, tErrorRaw, tRaw } = await import('../../public/js/i18n.js');

const UNKNOWN = tRaw('common.unknownError');
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test('ohne Übersetzung: common.unknownError statt rohem Code oder „error.CODE"-Key', () => {
  const err = Object.assign(new Error('HTTP 400'), { status: 400, code: 'SOME_UNTRANSLATED_CODE', body: { error_code: 'SOME_UNTRANSLATED_CODE' } });
  const msg = quiet(() => tFetchErrorRaw(err));
  assert.equal(msg, UNKNOWN);
  assert.ok(!msg.includes('SOME_UNTRANSLATED_CODE'));
  assert.equal(quiet(() => tErrorRaw({ error_code: 'SOME_UNTRANSLATED_CODE' })), UNKNOWN);
});

test('ohne Code: die Error-Message (Netzfehler, HTTP-Status)', () => {
  assert.equal(tFetchErrorRaw(Object.assign(new Error('HTTP 502'), { status: 502, code: null })), 'HTTP 502');
  assert.equal(tFetchErrorRaw(new TypeError('Failed to fetch')), 'Failed to fetch');
});

test('tErrorRaw: Legacy-Freitext und leere Antwort', () => {
  assert.equal(tErrorRaw({ error: 'freier Text' }), 'freier Text');
  assert.equal(tErrorRaw(null), UNKNOWN);
});

test('ohne Fehlerobjekt: kein Crash', () => {
  assert.equal(typeof tFetchErrorRaw(null), 'string');
});

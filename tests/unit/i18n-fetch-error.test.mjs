// tFetchError / tErrorRaw (i18n.js): Fehlertext für einen Request-Fehler.
// Übersetzter error_code › common.unknownError (keine Übersetzung — der rohe Code
// ist kein Satz für den User und geht nur in die Konsole); Netzausfall →
// common.networkError; nie die rohe `HTTP 502`-/„Failed to fetch"-Message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tFetchError, tErrorRaw, tRaw } = await import('../../public/js/i18n.js');

const UNKNOWN = tRaw('common.unknownError');
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test('ohne Übersetzung: common.unknownError statt rohem Code oder „error.CODE"-Key', () => {
  const err = Object.assign(new Error('HTTP 400'), { status: 400, code: 'SOME_UNTRANSLATED_CODE', body: { error_code: 'SOME_UNTRANSLATED_CODE' } });
  const msg = quiet(() => tFetchError(err));
  assert.equal(msg, UNKNOWN);
  assert.ok(!msg.includes('SOME_UNTRANSLATED_CODE'));
  assert.equal(quiet(() => tErrorRaw({ error_code: 'SOME_UNTRANSLATED_CODE' })), UNKNOWN);
});

test('ohne Code: Netzausfall und nackter HTTP-Status werden übersetzt, nie roh', () => {
  const NET = tRaw('common.networkError');
  assert.equal(tFetchError(Object.assign(new Error('HTTP 502'), { status: 502, code: null })), UNKNOWN);
  assert.equal(tFetchError(Object.assign(new TypeError('Failed to fetch'), { status: 0 })), NET);
  assert.equal(tFetchError(new TypeError('Failed to fetch')), NET);
});

test('Server-Body ohne Code: Legacy-Freitext; eigener new Error(text): dessen Text', () => {
  assert.equal(tFetchError(Object.assign(new Error('HTTP 400: x'), { status: 400, body: { error: 'freier Text' } })), 'freier Text');
  assert.equal(tFetchError(new Error('schon übersetzt')), 'schon übersetzt');
});

test('tErrorRaw: Legacy-Freitext und leere Antwort', () => {
  assert.equal(tErrorRaw({ error: 'freier Text' }), 'freier Text');
  assert.equal(tErrorRaw(null), UNKNOWN);
});

test('ohne Fehlerobjekt: kein Crash', () => {
  assert.equal(typeof tFetchError(null), 'string');
});

// Diagnose-Felder am Page-Save: `save_reason` (welcher Weg speichert) und
// `client_tab` landen in der PAGE_CONFLICT-Logzeile — dort nur als
// bereinigtes Token, damit der Request-Body keine Zeilen ins Log schreibt.
//
// Ebenso hier: das Log-Level der PAGE_SAVE-Zeile. Routine-Saves stehen auf
// `debug` (auf Prod dominierten sie das Log), `info` nur fuer die
// Besonderheiten — Wiederholung, eigener Vorgaenger-Save, Retry/Outbox und
// der No-op-Save (unveraenderter Stand).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _logToken, _isNotableSave, _saveSuffix } = require('../../routes/content/shared.js');
const { buildSavePayload } = await import('../../public/js/editor/shared/save-pipeline.js');

test('buildSavePayload: reason → save_reason, ohne reason kein Feld', () => {
  const base = { html: '<p>x</p>', pageName: 'A', source: 'main', expectedUpdatedAt: 't' };
  assert.equal(buildSavePayload({ ...base, reason: 'autosave' }).save_reason, 'autosave');
  assert.equal('save_reason' in buildSavePayload(base), false);
});

test('_logToken: nur kurze Kennungen aus [A-Za-z0-9_-], sonst „-"', () => {
  assert.equal(_logToken('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
  assert.equal(_logToken('outbox-merge'), 'outbox-merge');
  assert.equal(_logToken('x\nPAGE_CONFLICT gefälscht'), '-');
  assert.equal(_logToken('a'.repeat(33)), '-');
  assert.equal(_logToken(undefined), '-');
  assert.equal(_logToken(42), '-');
});

test('_isNotableSave: Routine-Saves sind debug, Besonderheiten info', () => {
  // Routine: Autosave, quick, save, kein Weg (native Clients senden keinen).
  for (const reason of [undefined, 'quick', 'autosave', 'save']) {
    const body = reason ? { save_reason: reason } : {};
    assert.equal(_isNotableSave({}, body), false, `Weg ${reason} ist Routine`);
  }
  // Besonderheiten: Wiederholung/Outbox/Retry/Konflikt-Aufloesung.
  for (const reason of ['retry', 'outbox', 'outbox-merge', 'resolve', 'own-echo', 'remerge']) {
    assert.equal(_isNotableSave({}, { save_reason: reason }), true, `Weg ${reason} ist besonders`);
  }
  // Server-Kennzeichen: eigener Vorgaenger-Save, Wiederholung, No-op-Save.
  assert.equal(_isNotableSave({ save_match: 'own' }, {}), true);
  assert.equal(_isNotableSave({ save_match: 'replay' }, {}), true);
  assert.equal(_isNotableSave({ no_change: true }, {}), true);
});

test('_saveSuffix: Klammerzusatz der PAGE_SAVE-Zeile', () => {
  assert.equal(_saveSuffix({}), '');
  assert.equal(_saveSuffix({ save_match: 'own' }), ' (eigener Vorgaenger-Save)');
  assert.equal(_saveSuffix({ save_match: 'replay' }), ' (Wiederholung)');
  assert.equal(_saveSuffix({ no_change: true }), ' (unveraendert)');
});

// Drift-Test: die PAGE_SAVE-Zeile steht an GENAU EINER Stelle, und die
// Level-Entscheidung hängt an `_isNotableSave` (Routine → debug). Wer die
// Zeile wieder pauschal auf `info` setzt, flutet das Prod-Log.
test('PAGE_SAVE-Logzeile: eine Fundstelle, Routine auf debug', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../routes/content/pages.js', import.meta.url), 'utf8');
  const hits = src.match(/PAGE_SAVE Seite/g) || [];
  assert.equal(hits.length, 1, 'PAGE_SAVE wird an genau einer Stelle geloggt');
  assert.match(src, /if \(_isNotableSave\(saved, req\.body\)\) logger\.info\(line\);\s*else logger\.debug\(line\);/,
    'Level-Entscheidung: Besonderheiten auf info, Routine auf debug');
});

// Diagnose-Felder am Page-Save: `save_reason` (welcher Weg speichert) und
// `client_tab` landen in der PAGE_CONFLICT-Logzeile — dort nur als
// bereinigtes Token, damit der Request-Body keine Zeilen ins Log schreibt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _logToken } = require('../../routes/content/shared.js');
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

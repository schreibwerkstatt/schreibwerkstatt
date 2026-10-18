// Unit-Tests fuer lib/media-mime.js — gebundene Content-Types fuer BLOB-Auslieferung.
//
// Lauf: `node --test tests/unit/media-mime.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { safeImageMime, safeDocMime } = require('../../lib/media-mime.js');

test('safeImageMime: nur Raster-Typen, normalisiert', () => {
  assert.equal(safeImageMime('image/png'), 'image/png');
  assert.equal(safeImageMime('IMAGE/JPEG; charset=x'), 'image/jpeg');
  for (const bad of ['text/html', 'image/svg+xml', 'text/javascript', 'application/xhtml+xml', '', null, undefined]) {
    assert.equal(safeImageMime(bad), null, String(bad));
  }
});

test('safeDocMime: nur PDF', () => {
  assert.equal(safeDocMime('application/pdf'), 'application/pdf');
  for (const bad of ['text/html', 'text/javascript', 'application/javascript', null]) {
    assert.equal(safeDocMime(bad), null, String(bad));
  }
});

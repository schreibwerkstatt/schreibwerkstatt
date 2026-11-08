// Export-Dateinamen (lib/filenames.js): Zeitstempel in app.timezone statt
// Server-TZ, Namensteil dateisystem-tauglich.
//
// Lauf: `node --test tests/unit/filenames.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('filenames-test');
require('../../db/migrations');
const { formatExportTimestamp, fileSafeName, buildExportFilename } = require('../../lib/filenames');

test('Zeitstempel folgt der Zeitzone, nicht der Server-Uhr', () => {
  const d = new Date('2026-07-10T22:30:05Z');
  assert.equal(formatExportTimestamp(d, 'Europe/Zurich'), '2026-07-11-00-30-05');
  assert.equal(formatExportTimestamp(d, 'UTC'), '2026-07-10-22-30-05');
  assert.equal(formatExportTimestamp(new Date('2026-01-01T00:00:00Z'), 'UTC'), '2026-01-01-00-00-00');
});

test('fileSafeName: Diakritika weg, ß → ss, Rest → _', () => {
  assert.equal(fileSafeName('Grüße aus Zürich: Teil 2/3'), 'Grusse_aus_Zurich_Teil_2_3');
  assert.equal(fileSafeName(''), 'book');
  assert.equal(fileSafeName('///'), 'book');
});

test('buildExportFilename setzt die Teile zusammen', () => {
  assert.match(buildExportFilename({ prefix: 'pdf', slug: 'Mein Buch', ext: 'pdf', date: new Date() }),
    /^pdf-Mein_Buch-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.pdf$/);
});

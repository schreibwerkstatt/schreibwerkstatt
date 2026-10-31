// Befunde, deren `original` im geprüften Text mehrfach vorkommt, tragen
// `mehrdeutig: true` (routes/jobs/lektorat-page.js#markAmbiguous) — das Frontend
// wählt sie nicht vor, weil «Übernehmen» das erste Vorkommen ersetzt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { countInText } from '../../public/js/utils/text-match.js';

const require = createRequire(import.meta.url);
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('lektorat-ambiguous');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');
const { markAmbiguous, dropUnlocatable } = require('../../routes/jobs/lektorat-page.js');

const TEXT = 'Er sagte, dass er kommt. Sie wusste, dass er lügt. «Ja», sagte er.';

test('mehrfaches original → mehrdeutig, eindeutiges ohne Flag', () => {
  const out = markAmbiguous([
    { typ: 'grammatik', original: 'dass er', korrektur: 'das er' },
    { typ: 'grammatik', original: 'dass er kommt', korrektur: 'das er kommt' },
  ], TEXT, countInText);
  assert.equal(out[0].mehrdeutig, true);
  assert.equal('mehrdeutig' in out[1], false);
});

test('gezählt in der Normalform der Fundstellen-Suche (Anführungszeichen gefaltet)', () => {
  const out = markAmbiguous([{ typ: 'stil', original: '"Ja", sagte er', korrektur: 'x' }], TEXT, countInText);
  assert.equal('mehrdeutig' in out[0], false);
});

test('veraltetes Flag aus dem Cache fällt weg', () => {
  const out = markAmbiguous([{ typ: 'stil', original: 'Sie wusste', korrektur: 'x', mehrdeutig: true }], TEXT, countInText);
  assert.equal('mehrdeutig' in out[0], false);
});

// Falsch zitierte Befunde fallen schon am Server weg (dropUnlocatable): sonst zählten
// Verlauf und Heatmap mehr Befunde, als die Liste zeigt.
test('nicht auffindbares original fällt weg, Befund ohne original bleibt', () => {
  const { fehler, dropped } = dropUnlocatable([
    { typ: 'grammatik', original: 'dass er kommt', korrektur: 'das er kommt' },
    { typ: 'grammatik', original: 'dass sie geht', korrektur: 'das sie geht' },
    { typ: 'stil', original: '"Ja", sagte er', korrektur: 'x' },
    { typ: 'stil', korrektur: 'ohne Stelle' },
  ], TEXT, countInText);
  assert.equal(dropped, 1);
  assert.deepEqual(fehler.map(f => f.original), ['dass er kommt', '"Ja", sagte er', undefined]);
});

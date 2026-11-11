// Unit: Auswahl der Welt-Fakten für EINEN Abschnitt (lib/lektorat-weltfakten.js) —
// Grundlage der Lektorat-Typen «weltfakt»/«soziolekt» und des Abschnitts-Chat-Blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectPageWorldFacts, MAX_WELT } = require('../../lib/lektorat-weltfakten');

const F = (o) => ({ kategorie: 'ort', subjekt: null, fakt: 'x', seite: null, chapter_ids: [], ...o });

test('Subjekt im Text schlägt Kapitel-Bezug; fremde Kapitel ohne Erwähnung fallen weg', () => {
  const facts = [
    F({ subjekt: 'Brunnen', fakt: 'Der Brunnen ist versiegt', chapter_ids: [1] }),
    F({ subjekt: 'Turm', fakt: 'Der Turm hat sieben Stockwerke', chapter_ids: [2] }),
    F({ subjekt: 'Hafen', fakt: 'Der Hafen ist gesperrt', chapter_ids: [2] }),
  ];
  const { welt } = selectPageWorldFacts({ facts, chapterId: 1, text: 'Sie stieg auf den TURM.' });
  assert.deepEqual(welt.map(f => f.subjekt), ['Turm', 'Brunnen']);
});

test('Fakten aus diesem Abschnitt selbst fallen weg (Überarbeitung, kein Widerspruch)', () => {
  const facts = [F({ subjekt: 'Turm', seite: 'Aufstieg' }), F({ subjekt: 'Turm', fakt: 'y', seite: 'Ankunft' })];
  const { welt } = selectPageWorldFacts({ facts, text: 'Der Turm', pageName: 'Aufstieg' });
  assert.deepEqual(welt.map(f => f.fakt), ['y']);
});

test('Soziolekt nur für Figuren im Text; erstes Wort eines Paar-Subjekts reicht', () => {
  const facts = [
    F({ kategorie: 'soziolekt', subjekt: 'Adrian', fakt: 'spricht biblisch' }),
    F({ kategorie: 'soziolekt', subjekt: 'Claudia', fakt: 'spricht jovial' }),
    F({ kategorie: 'historie', subjekt: 'Adrian und Renate', fakt: 'waren Klassenkameraden' }),
  ];
  const r = selectPageWorldFacts({ facts, text: '«Gott hilft», sagte Adrian.' });
  assert.deepEqual(r.soziolekte.map(f => f.subjekt), ['Adrian']);
  assert.deepEqual(r.welt.map(f => f.subjekt), ['Adrian und Renate']);
});

test('Deckel greift', () => {
  const facts = Array.from({ length: 100 }, (_, i) => F({ subjekt: 'Turm', fakt: `Fakt ${i}` }));
  assert.equal(selectPageWorldFacts({ facts, text: 'Turm' }).welt.length, MAX_WELT);
});

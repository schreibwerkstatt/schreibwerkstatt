// Motiv-Scan — Recall-Helfer: Trigger-Prefix (deutsche Flexion) + buchgrössen-
// abhängiges Fundstellen-Cap (TOP_K). Reine Funktionen, kein DB/AI nötig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _triggerQuery, _computeTopK } = require('../../routes/jobs/motif-scan.js');

// _triggerQuery steuert die Präfix-Regel über die Syntax von buildMatchQuery, die
// sonst JEDES Wort ab 3 Zeichen selbst zum Präfix macht. Darum hier der ganze Weg
// bis zum MATCH-Ausdruck, nicht nur der Zwischenstring.
const { buildMatchQuery } = require('../../lib/search/match-query.js');
const fts = (term) => buildMatchQuery(_triggerQuery(term));

test('_triggerQuery: Einzelwörter ab 5 Zeichen werden Präfix (Flexion), kurze bleiben exakt', () => {
  // Lange Einzelwörter → Präfix (fängt Wassers/Wasserns/Wasserfall).
  assert.equal(_triggerQuery('Wasser'), 'Wasser*');
  assert.equal(_triggerQuery('Spiegel'), 'Spiegel*');
  assert.equal(_triggerQuery('Blume'), 'Blume*');      // genau an der Schwelle (5)
  // Kurze Wörter bleiben exakt (Präfix überdehnte: See* → Seele) — auch NACH
  // buildMatchQuery, deren Auto-Präfix ab 3 Zeichen sonst greift.
  assert.equal(_triggerQuery('See'), '"See"');
  assert.equal(fts('See'), '"See"');
  assert.equal(fts('Weg'), '"Weg"');
});

test('_triggerQuery: Mehrwort ist eine exakte Phrase, kein UND über Präfixe', () => {
  assert.equal(_triggerQuery('rotes Kleid'), '"rotes Kleid"');
  assert.equal(fts('rotes Kleid'), '"rotes Kleid"');
  assert.equal(fts('  das   Lied '), '"das Lied"');    // Leerraum normalisiert
  assert.equal(fts('das "rote" Kleid*'), '"das rote Kleid"'); // Anführung/Stern im Mehrwort entfernt
});

test('_triggerQuery: vom Autor gesetztes * bleibt, leer bleibt leer', () => {
  assert.equal(_triggerQuery('Wass*'), 'Wass*');
  assert.match(fts('Wass*'), /"Wass"\*/);
  assert.equal(_triggerQuery('  '), '');
  assert.equal(_triggerQuery(null), '');
});

test('_computeTopK: skaliert mit der Buchgrösse, unten/oben geklammert', () => {
  assert.equal(_computeTopK(0), 40);      // leeres/kleines Buch → Basis
  assert.equal(_computeTopK(50), 40);     // unter Basis-Schwelle → Basis
  assert.equal(_computeTopK(200), 100);   // 200 × 0.5
  assert.equal(_computeTopK(1000), 500);  // gedeckelt bei Max
  assert.equal(_computeTopK(5000), 500);  // bleibt gedeckelt
});

// [#id]-Marker in Freitext → «Titel» (routes/jobs/plot/beat-refs.js): Brainstorm,
// Plot-Chat-Vorschläge und Konsistenz-Befunde. Die Autorin sieht keine Beat-IDs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveBeatRefs } = require('../../routes/jobs/plot/beat-refs');
const { normalizeKonflikte, normalizeErledigt } = require('../../routes/jobs/plot/result');

const titles = new Map([[33, 'Manuel entfremdet sich'], [101, 'Eifersucht akzentuiert sich'], [53, 'Stefan erwischt Renate'], [42, 'Neuer Job']]);

test('resolveBeatRefs: bekannte Nummern werden zu «Titel», in jeder Schreibweise', () => {
  assert.equal(resolveBeatRefs('macht dessen Entfremdung (#33) endgültig', titles), 'macht dessen Entfremdung («Manuel entfremdet sich») endgültig');
  assert.equal(resolveBeatRefs('Setup für #101/#53', titles), 'Setup für «Eifersucht akzentuiert sich»/«Stefan erwischt Renate»');
  assert.equal(resolveBeatRefs('folgt auf [#42]', titles), 'folgt auf «Neuer Job»');
});

test('resolveBeatRefs: steht der Titel schon dahinter, fällt nur der Marker weg', () => {
  assert.equal(resolveBeatRefs('[#42] Neuer Job folgt', titles), 'Neuer Job folgt');
  assert.equal(resolveBeatRefs('[#42] «Neuer Job» folgt', titles), '«Neuer Job» folgt');
});

test('resolveBeatRefs: unbekannte Nummern und Text ohne # bleiben unverändert', () => {
  assert.equal(resolveBeatRefs('Platz #1 und #7', titles), 'Platz #1 und #7');
  assert.equal(resolveBeatRefs('Kein Verweis', titles), 'Kein Verweis');
  assert.equal(resolveBeatRefs('&#33; HTML-Entity', titles), '&#33; HTML-Entity');
  assert.equal(resolveBeatRefs(undefined, titles), undefined);
});

test('normalizeKonflikte/normalizeErledigt lösen Nummern in Problem, Vorschlag und Erledigt auf', () => {
  const beats = [...titles].map(([id, titel]) => ({ id, titel }));
  const [k] = normalizeKonflikte([{ beat: 'Neuer Job', beat_id: 42, schwere: 'mittel', typ: 'logik', problem: 'Widerspricht #33.', vorschlag: 'Vor [#101] stellen.' }],
    { beats, typEnum: ['logik'], relTypes: [] });
  assert.equal(k.problem, 'Widerspricht «Manuel entfremdet sich».');
  assert.equal(k.vorschlag, 'Vor «Eifersucht akzentuiert sich» stellen.');
  assert.deepEqual(normalizeErledigt(['#53 ist jetzt eingelöst'], true, beats), ['«Stefan erwischt Renate» ist jetzt eingelöst']);
});

'use strict';
// Katalog-Anker, Signaturen und die Identitäts-Härtungen der Komplettanalyse:
//  - katalog-anker.js: Anker → Hint, Doppelbeanspruchung, Vorrang vor dem Judge
//  - signatures.js: Buchkontext und geerbter Effort verschieben die Cache-Basis
//  - multi-pass: angehängte Outputs (Gap, Hälften) kollidieren nicht in den fig_ids
//  - buildFigNameLookup: Token-Fallback respektiert Anrede/Geschlecht
//  - entity-match: Allerwelts-Indizien tragen keinen Merge, Ort-Anker schlägt Namen
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAnker, ankerHints, mergeHints } = require('../../routes/jobs/komplett/katalog-anker');
const { extractCacheBase, sysSig, EXTRACT_SYS_KEYS } = require('../../routes/jobs/komplett/signatures');
const { appendFigurenKollisionsfrei } = require('../../routes/jobs/komplett/phases/extraktion/multi-pass');
const { annotateBeziehungenNames } = require('../../routes/jobs/komplett/figuren-merge');
const { buildFigNameLookup } = require('../../routes/jobs/komplett/utils');
const {
  scoreFigurePair, matchLocations, figureHintKey, locationHintKey, sceneHintKey,
  dedupeLocationsWithinRun, SAME, UNSURE,
} = require('../../lib/entity-match');
const { runWithContext } = require('../../lib/log-context');

const NOLOG = { info() {}, warn() {} };

test('parseAnker: K12 / k 12 / 12 → 12, Fremdes → null', () => {
  assert.equal(parseAnker('K12', 'K'), 12);
  assert.equal(parseAnker(' k 12 ', 'K'), 12);
  assert.equal(parseAnker('12', 'K'), 12);
  assert.equal(parseAnker('O12', 'K'), null);
  assert.equal(parseAnker('', 'K'), null);
  assert.equal(parseAnker(null, 'K'), null);
});

test('ankerHints: nur Bestands-IDs, doppelt beanspruchte fallen an die Regel zurück', () => {
  const figuren = [
    { id: 'fig_1', katalog_id: 'K5' },
    { id: 'fig_2', katalog_id: 'K6' },
    { id: 'fig_3', katalog_id: 'K6' },   // zweimal K6 → keiner bekommt den Anker
    { id: 'fig_4', katalog_id: 'K99' },  // gibt es nicht
    { id: 'fig_5', katalog_id: '' },
  ];
  const { hint, conflicts } = ankerHints(figuren, { prefix: 'K', validIds: new Set([5, 6]), keyOf: figureHintKey });
  assert.deepEqual([...hint.entries()], [['fig_1', 5]]);
  assert.equal(conflicts, 1);
});

test('mergeHints: der Anker schlägt den Judge, auch bei derselben Bestandszeile', () => {
  const anker = new Map([['fig_1', 5]]);
  const judge = new Map([['fig_2', 5], ['fig_3', 8]]);
  const out = mergeHints(anker, judge);
  assert.equal(out.get('fig_1'), 5);
  assert.equal(out.has('fig_2'), false, 'Judge-Paar auf eine vom Anker beanspruchte Zeile entfällt');
  assert.equal(out.get('fig_3'), 8);
});

test('signatures: anderer Buchkontext im System-Block verschiebt die Cache-Basis', () => {
  const sysA = { SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS: [{ text: 'REALE ZEITLINIE: nein' }] };
  const sysB = { SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS: [{ text: 'REALE ZEITLINIE: ja' }] };
  assert.notEqual(sysSig(sysA, EXTRACT_SYS_KEYS), sysSig(sysB, EXTRACT_SYS_KEYS));
});

test('signatures: ein geerbter Effort (nur Job-Bag, kein Tier-Effort) verschiebt die Cache-Basis', () => {
  const base = (effort) => runWithContext(
    { aiJob: { provider: 'claude', model: 'claude-opus-4-8', effort } },
    () => extractCacheBase({ provider: 'claude', tier: {}, sys: {}, extractVersion: 'v1' }),
  );
  assert.notEqual(base('high'), base('medium'));
  assert.match(base('high'), /^claude-opus-4-8:v1:eehigh:sp/);
});

test('signatures: Tier-Modell schlägt das Job-Modell', () => {
  const sig = runWithContext(
    { aiJob: { provider: 'claude', model: 'claude-opus-4-8' } },
    () => extractCacheBase({ provider: 'claude', tier: { model: 'claude-sonnet-5' }, sys: {}, extractVersion: 'v1' }),
  );
  assert.match(sig, /^claude-sonnet-5:/);
});

test('appendFigurenKollisionsfrei: Gap-Output mit eigenem fig_1 bindet Basis-Beziehungen nicht um', () => {
  const base = [
    { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
    { id: 'fig_2', name: 'Paul', beziehungen: [] },
  ];
  const gap = [
    { id: 'fig_1', name: 'Wirt Kurt', beziehungen: [{ figur_id: 'fig_2', typ: 'kollege' }] },
    { id: 'fig_2', name: 'Magd Lene', beziehungen: [] },
  ];
  appendFigurenKollisionsfrei(base, gap);
  const ids = base.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, 'keine doppelten fig_ids');
  // Nach dem Anhängen bindet annotateBeziehungenNames nichts mehr falsch: alle Ziele
  // tragen ihren Namen aus dem eigenen Output.
  annotateBeziehungenNames([{ kapitel: 'K1', figuren: base }]);
  assert.equal(base[0].beziehungen[0].name, 'Paul');
  const kurt = base.find(f => f.name === 'Wirt Kurt');
  assert.equal(kurt.beziehungen[0].name, 'Magd Lene');
  const lene = base.find(f => f.name === 'Magd Lene');
  assert.equal(kurt.beziehungen[0].figur_id, lene.id, 'gap-interne Kante zeigt auf die neu nummerierte Figur');
});

test('buildFigNameLookup: «Frau Weber» bindet nicht an den einzigen «Weber», wenn das Geschlecht nicht passt', () => {
  const { figNameToIdLower } = buildFigNameLookup([
    { id: 'fig_1', name: 'Hans Weber', geschlecht: 'männlich' },
  ], [], [{ kapitel: 'K1', assignments: [{ figur_name: 'Frau Weber' }] }], [], NOLOG, 'job');
  assert.equal(figNameToIdLower['frau weber'], undefined);
});

test('buildFigNameLookup: «Frau Weber» bindet an die einzige weibliche Weber', () => {
  const { figNameToIdLower } = buildFigNameLookup([
    { id: 'fig_1', name: 'Hans Weber', geschlecht: 'männlich' },
    { id: 'fig_2', name: 'Anna Weber', geschlecht: 'weiblich' },
  ], [], [{ kapitel: 'K1', assignments: [{ figur_name: 'Frau Weber' }] }], [], NOLOG, 'job');
  assert.equal(figNameToIdLower['frau weber'], 'fig_2');
});

test('buildFigNameLookup: ein Teil eines mehrteiligen Namens bindet ohne Anrede nicht («Peter Weber» ≠ «Anna Weber»)', () => {
  const { figNameToIdLower } = buildFigNameLookup([
    { id: 'fig_2', name: 'Anna Weber', geschlecht: 'weiblich' },
  ], [], [{ kapitel: 'K1', assignments: [{ figur_name: 'Peter Weber' }] }], [], NOLOG, 'job');
  assert.equal(figNameToIdLower['peter weber'], undefined);
});

test('scoreFigurePair: Rename-Fallback braucht ein unterscheidendes Indiz', () => {
  const a = { name: 'Hans Müller', typ: 'nebenfigur', geschlecht: 'männlich', chapters: ['K3'] };
  const b = { name: 'Peter Graf', typ: 'nebenfigur', geschlecht: 'männlich', chapters: ['K3'] };
  assert.notEqual(scoreFigurePair(a, b).verdict, SAME);
  const c = { ...b, beruf: 'Bäcker' };
  const d = { ...a, beruf: 'Bäcker' };
  assert.equal(scoreFigurePair(d, c).verdict, SAME);
});

test('scoreFigurePair: Teilname mit nur Allerwelts-Indizien ist unsicher, nicht gleich', () => {
  const r = scoreFigurePair(
    { name: 'Anna Weber', typ: 'nebenfigur', geschlecht: 'weiblich', chapters: ['K1'] },
    { name: 'Anna', typ: 'nebenfigur', geschlecht: 'weiblich', chapters: ['K1'] },
  );
  assert.equal(r.verdict, UNSURE);
});

test('matchLocations: der Anker-Hint schlägt einen gleichnamigen anderen Bestandsort', () => {
  const existing = [{ id: 1, name: 'Bahnhof', typ: 'gebaeude' }, { id: 2, name: 'Hauptbahnhof Olten', typ: 'gebaeude' }];
  const incoming = [{ id: 'ort_1', name: 'Bahnhof', typ: 'gebaeude' }];
  const { matchOf } = matchLocations(existing, incoming, { hint: new Map([[locationHintKey(incoming[0]), 2]]) });
  assert.equal(matchOf.get(0), 2);
});

test('dedupeLocationsWithinRun: mehrdeutiger Kurzname verschmilzt mit keinem Kandidaten', () => {
  const { orte } = dedupeLocationsWithinRun([
    { name: 'Mathys AG (Bettlach)', typ: 'gebaeude' },
    { name: 'Mathys AG (Grenchen)', typ: 'gebaeude' },
    { name: 'Mathys AG', typ: 'gebaeude' },
  ]);
  assert.equal(orte.length, 3);
});

test('dedupeLocationsWithinRun: verschiedene Katalog-Anker bleiben zwei Orte', () => {
  const { orte } = dedupeLocationsWithinRun([
    { name: 'Kreuz', typ: 'gebaeude', katalog_id: 'O1' },
    { name: 'Kreuz', typ: 'gebaeude', katalog_id: 'O2' },
  ]);
  assert.equal(orte.length, 2);
});

test('sceneHintKey: gleicher Titel auf verschiedenen Seiten ergibt verschiedene Schlüssel', () => {
  assert.notEqual(
    sceneHintKey({ titel: 'Ankunft', chapterId: 3, pageId: 10 }),
    sceneHintKey({ titel: 'Ankunft', chapterId: 3, pageId: 11 }),
  );
});

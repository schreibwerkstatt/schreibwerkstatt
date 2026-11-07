// Unit-Tests fuer Entity-Linking-Match-Engine.
//
// Pure-Funktion buildRanges(text, entities): findet Vorkommen von
// Figuren-/Orte-Namen im Text, respektiert Unicode-Wortgrenzen, behandelt
// Kollisionen (Figur > Ort) und Overlaps deterministisch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRanges, toEntitiesList, buildFigureAliases } = await import('../../public/js/editor/notebook/entities.js');

const F = (id, name) => ({ id, name, kind: 'figure' });
const L = (id, name) => ({ id, name, kind: 'location' });

test('buildRanges: leere Eingaben → leeres Ergebnis', () => {
  assert.deepEqual(buildRanges('', [F(1, 'Anna')]), []);
  assert.deepEqual(buildRanges('Hallo', []), []);
  assert.deepEqual(buildRanges('Hallo', null), []);
});

test('buildRanges: einfacher Treffer am Wortanfang', () => {
  const out = buildRanges('Anna ging fort.', [F(1, 'Anna')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 4);
  assert.equal(out[0].kind, 'figure');
  assert.equal(out[0].id, 1);
});

test('buildRanges: case-insensitiv', () => {
  const out = buildRanges('Heute traf ich ANNA wieder.', [F(1, 'Anna')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 15);
  assert.equal(out[0].end, 19);
});

test('buildRanges: Teilstring-Schutz — "Anna" matcht nicht in "Annabelle"', () => {
  const out = buildRanges('Annabelle stand am Fenster.', [F(1, 'Anna')]);
  assert.deepEqual(out, []);
});

test('buildRanges: aber "Annabelle" matcht "Annabelle"', () => {
  const out = buildRanges('Annabelle stand am Fenster.', [F(1, 'Annabelle')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Annabelle');
});

test('buildRanges: mehrere Vorkommen desselben Namens', () => {
  const out = buildRanges('Anna sah Anna. Anna lachte.', [F(1, 'Anna')]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(r => r.start), [0, 9, 15]);
});

test('buildRanges: Unicode-Wortgrenzen — "Anna-Lena" gilt als ein Wort', () => {
  // "Anna" in "Anna-Lena" sollte NICHT matchen, weil "-" Wort-Zeichen ist.
  const out = buildRanges('Anna-Lena rief um Hilfe.', [F(1, 'Anna')]);
  assert.deepEqual(out, []);
});

test('buildRanges: Apostroph in Namen erlaubt — O\'Brien als Einheit', () => {
  // "Brien" alleine sollte NICHT matchen in "O'Brien".
  const out = buildRanges('Mister O\'Brien kam.', [F(1, 'Brien')]);
  assert.deepEqual(out, []);
});

test('buildRanges: vollstaendiger Name mit Apostroph matcht', () => {
  const out = buildRanges('Mister O\'Brien kam.', [F(1, 'O\'Brien')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'O\'Brien');
});

test('buildRanges: Kollision Figur ↔ Ort am gleichen Offset → Figur gewinnt', () => {
  // "Wald" existiert als Figur UND als Ort.
  const out = buildRanges('Wald sah den Wald an.', [F(1, 'Wald'), L(2, 'Wald')]);
  assert.equal(out.length, 2);
  // Beide Treffer als Figur (Ort wurde durch Kollision verworfen).
  assert.ok(out.every(r => r.kind === 'figure'));
});

test('buildRanges: Overlapping-Schutz — laengster Match zuerst, andere fallen weg', () => {
  // "Anna" als Figur + "Anna Schmidt" als andere Figur. Wenn beide am
  // gleichen Offset starten, gewinnt der laengere — andere wird verworfen.
  const out = buildRanges('Anna Schmidt klopfte.', [F(1, 'Anna'), F(2, 'Anna Schmidt')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Anna Schmidt');
});

test('buildRanges: Sortierung nach Start-Offset', () => {
  const out = buildRanges('Bob traf Anna in Berlin.', [
    F(1, 'Anna'),
    L(2, 'Berlin'),
    F(3, 'Bob'),
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(r => r.name), ['Bob', 'Anna', 'Berlin']);
});

test('buildRanges: leerer Name wird ignoriert', () => {
  const out = buildRanges('Anna kam.', [F(1, ''), F(2, '  '), F(3, 'Anna')]);
  assert.equal(out.length, 1);
});

test('buildRanges: Mark-Zeichen (Diakritika) als Wort-Zeichen', () => {
  // "Müller" matcht "Müller" trotz Umlaut; nicht aber "Müllerin".
  const out = buildRanges('Frau Müllerin und Herr Müller.', [F(1, 'Müller')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 23);
});

test('toEntitiesList: vereint Figuren und Orte mit kind-Annotation, leere Namen raus', () => {
  const figuren = [{ id: 1, name: 'Anna' }, { id: 2, name: '' }, { id: 3, name: null }];
  const orte    = [{ id: 10, name: 'Berlin' }, { id: 11, name: '' }];
  const list = toEntitiesList(figuren, orte);
  assert.deepEqual(list, [
    { id: 1, name: 'Anna', kind: 'figure' },
    { id: 10, name: 'Berlin', kind: 'location' },
  ]);
});

// ── Alias-Generierung ─────────────────────────────────────────────────────

test('buildFigureAliases: Vollname + Vorname + Nachname', () => {
  const aliases = buildFigureAliases({ id: 1, name: 'Lea Brunner', kurzname: 'Lea' });
  assert.deepEqual(aliases.sort(), ['Brunner', 'Lea', 'Lea Brunner'].sort());
});

test('buildFigureAliases: Single-Token-Name → nur Vollname', () => {
  assert.deepEqual(buildFigureAliases({ id: 1, name: 'Mephisto' }), ['Mephisto']);
});

test('buildFigureAliases: Drei-Teile-Name → Vorname-Prefix + Nachname-Suffix + erstes Token', () => {
  const aliases = buildFigureAliases({ id: 1, name: 'Anna Maria Schmidt', kurzname: 'Anna' });
  assert.ok(aliases.includes('Anna Maria Schmidt'));
  assert.ok(aliases.includes('Schmidt'));
  assert.ok(aliases.includes('Anna Maria'));
  assert.ok(aliases.includes('Anna'));
});

test('buildFigureAliases: kurzname kann Nachname sein (z.B. Daniel Moser / Moser)', () => {
  const aliases = buildFigureAliases({ id: 1, name: 'Daniel Moser', kurzname: 'Moser' });
  assert.ok(aliases.includes('Daniel Moser'));
  assert.ok(aliases.includes('Daniel'));
  assert.ok(aliases.includes('Moser'));
});

test('buildFigureAliases: zu kurze Aliase werden gefiltert (< 3 Zeichen)', () => {
  const aliases = buildFigureAliases({ id: 1, name: 'Bo Tan', kurzname: 'Bo' });
  // "Bo" < 3 → raus. "Tan" 3 Buchstaben → drin. Vollname drin.
  assert.ok(!aliases.includes('Bo'));
  assert.ok(aliases.includes('Bo Tan'));
});

test('buildFigureAliases: Stopwords werden gefiltert (z.B. der/die)', () => {
  const aliases = buildFigureAliases({ id: 1, name: 'Die Frau', kurzname: 'Die' });
  assert.ok(!aliases.includes('Die'));
  assert.ok(!aliases.includes('die'));
});

test('toEntitiesList: erzeugt mehrere Entries pro Figur mit gleicher id', () => {
  const list = toEntitiesList([{ id: 1, name: 'Lea Brunner', kurzname: 'Lea' }], []);
  const ids = list.map(e => e.id);
  assert.ok(ids.every(i => i === 1));
  const names = list.map(e => e.name);
  assert.ok(names.includes('Lea Brunner'));
  assert.ok(names.includes('Lea'));
  assert.ok(names.includes('Brunner'));
});

test('buildRanges: Aliase via toEntitiesList → Vorname/Nachname matchen', () => {
  const entities = toEntitiesList([{ id: 1, name: 'Lea Brunner', kurzname: 'Lea' }], []);
  const text = 'Brunner sagte, dass Lea nicht da war.';
  const out = buildRanges(text, entities);
  // Beide Erwaehnungen sollen matchen, beide → id=1.
  assert.equal(out.length, 2);
  assert.ok(out.every(r => r.id === 1));
  assert.deepEqual(out.map(r => r.name).sort(), ['Brunner', 'Lea']);
});

// containsWholeWord: Namensfund des Referenz-Slots — dieselbe Wortgrenzen-Regel
// wie buildRanges, damit „im Abschnitt" und Editor-Highlight übereinstimmen.
const { containsWholeWord } = await import('../../public/js/editor/notebook/entities.js');

test('containsWholeWord: ganzes Wort, case-insensitiv', () => {
  assert.equal(containsWholeWord('dann kam anna herein', 'Anna'), true);
  assert.equal(containsWholeWord('Anna.', 'anna'), true);
  assert.equal(containsWholeWord('«Anna»', 'Anna'), true);
});

test('containsWholeWord: kein Treffer im Wortinneren', () => {
  assert.equal(containsWholeWord('die annahme war falsch', 'Anna'), false);
  assert.equal(containsWholeWord('in der kapelle', 'Ella'), false);
  assert.equal(containsWholeWord('anna-lena lachte', 'Anna'), false, 'Bindestrich zählt als Wortzeichen');
});

test('containsWholeWord: späteres Vorkommen nach Fehltreffer wird gefunden', () => {
  assert.equal(containsWholeWord('annahme, dann anna', 'Anna'), true);
});

test('containsWholeWord: leere Eingaben', () => {
  assert.equal(containsWholeWord('', 'Anna'), false);
  assert.equal(containsWholeWord('anna', ''), false);
  assert.equal(containsWholeWord('anna', null), false);
});

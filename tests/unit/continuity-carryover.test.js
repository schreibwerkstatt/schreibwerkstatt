'use strict';
// Unit: Wiedererkennung von Kontinuitäts-Befunden über Läufe (lib/continuity-carryover.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { carryOverStatus, sameIssue, issueSignature } = require('../../lib/continuity-carryover');

const PRIOR = {
  typ: 'figur', chapter_ids: [3, 5], figuren: ['Marek'],
  stelle_a: 'Kapitel 3: «Marek lag reglos unter den Trümmern»',
  stelle_b: 'Kapitel 5: «Marek öffnete die Tür und lachte»',
  dismissed: true, dismissed_at: '2026-10-01T10:00:00.000Z', resolved: false,
};

test('derselbe Befund, neu formuliert → Status übernommen', () => {
  const neu = {
    typ: 'figur', chapter_ids: [5, 3], figuren: ['Marek'],
    stelle_a: 'Kapitel 3: «Marek lag reglos unter den Trümmern des Hauses»',
    stelle_b: 'Kapitel 5: «Marek öffnete lachend die Tür»',
  };
  const [st] = carryOverStatus([neu], [PRIOR]);
  assert.deepEqual(st, { resolved: false, resolved_at: null, dismissed: true, dismissed_at: PRIOR.dismissed_at });
});

test('anderer Widerspruch im selben Kapitel → nicht übernommen', () => {
  const neu = {
    typ: 'figur', chapter_ids: [3, 5], figuren: ['Marek'],
    stelle_a: 'Kapitel 3: «Er trug den blauen Mantel seines Vaters»',
    stelle_b: 'Kapitel 5: «Der Mantel war grün und neu»',
  };
  assert.deepEqual(carryOverStatus([neu], [PRIOR]), [null]);
});

test('andere Figur → nicht derselbe', () => {
  assert.equal(sameIssue(issueSignature({ ...PRIOR, figuren: ['Lena'] }), issueSignature(PRIOR)), false);
});

test('Typwechsel bei fast gleichen Stellen → derselbe; bei nur mässigem Überlapp nicht', () => {
  const base = issueSignature(PRIOR);
  // Dasselbe falsche Alter, einmal «figur», einmal «zeitlinie» geführt.
  assert.equal(sameIssue(issueSignature({ ...PRIOR, typ: 'zeitlinie' }), base), true);
  const umformuliert = {
    stelle_a: 'Kapitel 3: «Marek lag reglos unter den Trümmern des Hauses»',
    stelle_b: 'Kapitel 5: «Marek öffnete lachend die Tür»',
  };
  assert.equal(sameIssue(issueSignature({ ...PRIOR, ...umformuliert }), base), true);
  assert.equal(sameIssue(issueSignature({ ...PRIOR, ...umformuliert, typ: 'zeitlinie' }), base), false);
});

test('bei Gleichstand erbt der Kandidat desselben Typs', () => {
  const gleicherTyp = { ...PRIOR, check_id: 1, dismissed: false, dismissed_at: null };
  const andererTyp = { ...PRIOR, check_id: 1, typ: 'zeitlinie' };
  // gleicherTyp ist offen → der neue Befund bleibt offen, obwohl andererTyp verworfen ist
  assert.deepEqual(carryOverStatus([{ ...PRIOR }], [andererTyp, gleicherTyp]), [null]);
});

test('gemeinsamer Seitenanker macht verschiedene Kapitel-IDs vereinbar', () => {
  // Alter Lauf ordnete das Kapitel über einen Namen zu, den auch ein Abschnitt trägt.
  const alt = { ...PRIOR, chapter_ids: [4], page_a_id: 24, page_b_id: 55 };
  const neu = { ...PRIOR, chapter_ids: [11], page_a_id: 24, page_b_id: 55 };
  assert.equal(carryOverStatus([neu], [alt])[0]?.dismissed, true);
  const ohneAnker = { ...PRIOR, chapter_ids: [11] };
  assert.equal(carryOverStatus([ohneAnker], [{ ...alt, page_a_id: null, page_b_id: null }])[0], null);
});

test('jeder frühere Befund wird höchstens einmal vergeben', () => {
  const out = carryOverStatus([{ ...PRIOR }, { ...PRIOR }], [PRIOR]);
  assert.ok(out[0]);
  assert.equal(out[1], null);
});

test('nicht auflösbare Kapitelnamen zählen nicht — nur aufgelöste IDs', () => {
  // Gespeichert werden nur aufgelöste Kapitel-Bridges: der alte Befund trägt den Namen
  // «Gesamtbuch» nicht mehr, der neue schon. Beide müssen trotzdem gleich aussehen.
  const p = { ...PRIOR, chapter_ids: [], kapitel: [] };
  const n = { ...PRIOR, chapter_ids: [], kapitel: ['Gesamtbuch'] };
  assert.equal(sameIssue(issueSignature(n), issueSignature(p)), true);
  const mixed = { ...PRIOR, kapitel: ['Kapitel 3', 'Kapitel 5', 'Kapitl 9'] };
  assert.equal(sameIssue(issueSignature(mixed), issueSignature(PRIOR)), true);
});

test('„erledigt" wird nie übernommen', () => {
  const p = { ...PRIOR, dismissed: false, dismissed_at: null, resolved: true, resolved_at: '2026-10-01T10:00:00.000Z' };
  assert.deepEqual(carryOverStatus([{ ...PRIOR }], [p]), [null]);
});

test('jüngste Zeile zählt: aufgehobenes „kein Fehler" kommt nicht über die ältere Kopie zurück', () => {
  const lauf1 = { ...PRIOR, check_id: 1 };                                              // verworfen
  const lauf2 = { ...PRIOR, check_id: 2, dismissed: false, dismissed_at: null };         // geerbt, dann aufgehoben
  // prior: neueste zuerst
  assert.deepEqual(carryOverStatus([{ ...PRIOR }], [lauf2, lauf1]), [null]);
  // auch ein zweiter neuer Befund greift nicht auf die verdeckte ältere Kopie zu
  assert.deepEqual(carryOverStatus([{ ...PRIOR }, { ...PRIOR }], [lauf2, lauf1]), [null, null]);
});

test('ein älterer verworfener Befund, den der jüngste Lauf nicht fand, vererbt weiter', () => {
  const other = {
    ...PRIOR, check_id: 2, typ: 'zeitlinie', dismissed: false,
    stelle_a: 'Kapitel 3: «Es war der Sommer 1985»', stelle_b: 'Kapitel 5: «Im Winter 1983 kehrte er zurück»',
  };
  const old = { ...PRIOR, check_id: 1 };
  const [st] = carryOverStatus([{ ...PRIOR }], [other, old]);
  assert.equal(st?.dismissed, true);
});

test('zwei ähnliche neue Befunde: nur der mit dem besten Überlapp erbt', () => {
  const nah = { ...PRIOR, stelle_a: PRIOR.stelle_a, stelle_b: PRIOR.stelle_b };
  const fern = { ...PRIOR, stelle_b: 'Kapitel 5: «Marek öffnete die Tür und lachte laut über den Witz des Wirts»' };
  // Reihenfolge absichtlich: der schwächere zuerst — «erster passender gewinnt» wäre falsch.
  const out = carryOverStatus([fern, nah], [{ ...PRIOR, check_id: 1 }]);
  assert.equal(out[0], null);
  assert.equal(out[1]?.dismissed, true);
});

// ── Toleranz bei Figuren-/Kapitelmengen ───────────────────────────────────────
test('eine Figur mehr oder weniger: „kein Fehler" bleibt', () => {
  const mehr = { ...PRIOR, figuren: ['Marek', 'Lena'] };
  const weniger = { ...PRIOR, figuren: [] };
  assert.equal(carryOverStatus([mehr], [PRIOR])[0]?.dismissed, true);
  assert.equal(carryOverStatus([weniger], [PRIOR])[0]?.dismissed, true);
  // Teilmenge mit zwei Figuren Unterschied ist ebenfalls derselbe Befund
  const viele = { ...PRIOR, figuren: ['Marek', 'Lena', 'Jonas'] };
  assert.equal(carryOverStatus([viele], [PRIOR])[0]?.dismissed, true);
});

test('ein Kapitel mehr oder weniger: „kein Fehler" bleibt; disjunkte Kapitel nicht', () => {
  assert.equal(carryOverStatus([{ ...PRIOR, chapter_ids: [3, 5, 7] }], [PRIOR])[0]?.dismissed, true);
  assert.equal(carryOverStatus([{ ...PRIOR, chapter_ids: [3] }], [PRIOR])[0]?.dismissed, true);
  assert.equal(carryOverStatus([{ ...PRIOR, chapter_ids: [8, 9] }], [PRIOR])[0], null);
});

test('disjunkte Figurenmengen bleiben verschiedene Befunde', () => {
  const p = { ...PRIOR, figuren: ['Marek', 'Lena'] };
  const n = { ...PRIOR, figuren: ['Jonas', 'Petra'] };
  assert.equal(sameIssue(issueSignature(n), issueSignature(p)), false);
});

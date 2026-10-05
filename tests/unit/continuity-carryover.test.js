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

test('anderer Typ oder andere Figur → nicht derselbe', () => {
  const base = issueSignature(PRIOR);
  assert.equal(sameIssue(issueSignature({ ...PRIOR, typ: 'zeitlinie' }), base), false);
  assert.equal(sameIssue(issueSignature({ ...PRIOR, figuren: ['Lena'] }), base), false);
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
  const other = { ...PRIOR, check_id: 2, typ: 'zeitlinie', dismissed: false };
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

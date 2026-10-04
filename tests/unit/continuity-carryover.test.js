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

test('ohne Kapitel-IDs vergleichen die Kapitelnamen', () => {
  const p = { ...PRIOR, chapter_ids: [], kapitel: ['Kapitel 3', 'Kapitel 5'] };
  const n = { ...PRIOR, chapter_ids: [], kapitel: ['kapitel 5', 'Kapitel 3'] };
  assert.equal(sameIssue(issueSignature(n), issueSignature(p)), true);
});

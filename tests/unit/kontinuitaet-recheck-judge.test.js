'use strict';
// Urteil des Nachprüf-Jobs (routes/jobs/komplett/job-recheck.js#judgeRecheck):
// «behoben» erledigt nur mit einem Beleg, der im mitgegebenen Text wörtlich steht.
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeRecheck } = require('../../routes/jobs/komplett/job-recheck');
const { normalizeForQuoteMatch } = require('../../lib/quote-verify');

const hay = normalizeForQuoteMatch('Renate war im März 1999 schwanger. Stefan wusste es seit Silvester.');

test('behoben mit wörtlichem Beleg → erledigt', () => {
  const v = judgeRecheck({ urteil: 'behoben', begruendung: 'passt', beleg: '«Stefan wusste es seit Silvester»' }, hay);
  assert.deepEqual(v, { verdict: 'behoben', reason: 'passt', beleg: '«Stefan wusste es seit Silvester»', resolve: true });
});

test('behoben ohne auffindbaren Beleg → unbelegt, bleibt offen', () => {
  const v = judgeRecheck({ urteil: 'behoben', begruendung: 'passt', beleg: 'Stefan erfuhr es im Januar' }, hay);
  assert.equal(v.verdict, 'unbelegt');
  assert.equal(v.resolve, false);
  const leer = judgeRecheck({ urteil: 'behoben', begruendung: 'passt', beleg: '' }, hay);
  assert.equal(leer.verdict, 'unbelegt');
});

test('teilweise/weiterhin erledigen nie; erfundener Beleg fällt weg; Unbekanntes → null', () => {
  assert.equal(judgeRecheck({ urteil: 'teilweise', beleg: 'März 1999' }, hay).resolve, false);
  assert.equal(judgeRecheck({ urteil: 'teilweise', beleg: 'März 1999' }, hay).beleg, 'März 1999');
  assert.equal(judgeRecheck({ urteil: 'weiterhin', beleg: 'gibt es nicht' }, hay).beleg, '');
  assert.equal(judgeRecheck({ urteil: 'vielleicht' }, hay), null);
  assert.equal(judgeRecheck(null, hay), null);
});

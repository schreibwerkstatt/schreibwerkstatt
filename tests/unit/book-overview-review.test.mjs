// Bewertungs-Kachel der Buch-Uebersicht (public/js/book-overview/review.js):
// eine fehlende oder nicht numerische Gesamtnote ist „keine Note", nicht 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewScore, reviewTrend } from '../../public/js/book-overview/review.js';

const rv = (gesamtnote) => ({ review_json: { gesamtnote } });

test('reviewScore: Zahl, numerischer String, geklemmt', () => {
  assert.equal(reviewScore(rv(4.5)), 4.5);
  assert.equal(reviewScore(rv('3')), 3);
  assert.equal(reviewScore(rv(9)), 6);
  assert.equal(reviewScore(rv(0)), 0, 'eine echte 0 bleibt 0');
});

test('reviewScore: fehlend / null / leer / nicht numerisch → null', () => {
  assert.equal(reviewScore(null), null);
  assert.equal(reviewScore({ review_json: null }), null);
  assert.equal(reviewScore(rv(null)), null);
  assert.equal(reviewScore(rv(undefined)), null);
  assert.equal(reviewScore(rv('')), null);
  assert.equal(reviewScore(rv('gut')), null);
});

test('reviewTrend: nur mit zwei Noten, Gleichstand → null', () => {
  assert.deepEqual(reviewTrend(rv(4.5), rv(4)), { dir: 'up', delta: 0.5 });
  assert.deepEqual(reviewTrend(rv(3), rv(4)), { dir: 'down', delta: -1 });
  assert.equal(reviewTrend(rv(4), rv(4)), null);
  assert.equal(reviewTrend(rv(4), rv(null)), null, 'Vorbewertung ohne Note');
  assert.equal(reviewTrend(rv(null), rv(4)), null, 'aktuelle Bewertung ohne Note — kein Absturz auf 0');
});

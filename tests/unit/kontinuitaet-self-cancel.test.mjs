// Selbst-Entwarnung der Kontinuitätsprüfung: massgeblich ist ausschliesslich das
// Pflichtfeld `entwarnung` (routes/jobs/komplett/remap.js#_isEntwarnung). Prosa wird
// nicht mehr per Regex ausgewertet — ein Befund wie «bis Kapitel 5 konsistent, in
// Kapitel 9 grün» ist ein echter Widerspruch und darf nicht verschwinden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _isEntwarnung } = require('../../routes/jobs/komplett/remap.js');

test('entwarnung === true (auch als String «true») ist eine Entwarnung', () => {
  assert.equal(_isEntwarnung({ entwarnung: true }), true);
  assert.equal(_isEntwarnung({ entwarnung: 'true' }), true);
  assert.equal(_isEntwarnung({ entwarnung: ' TRUE ' }), true);
});

test('entwarnung false/fehlend ist keine Entwarnung — egal, was die Prosa sagt', () => {
  for (const p of [
    { entwarnung: false, beschreibung: 'Die Augenfarbe ist bis Kapitel 5 konsistent, in Kapitel 9 grün.' },
    { entwarnung: false, beschreibung: 'Kein Widerspruch.', empfehlung: 'Eintrag entfernen.' },
    { beschreibung: 'Die Angaben sind in sich konsistent.' },
    { entwarnung: 'false' }, { entwarnung: 0 }, { entwarnung: 1 }, {}, null, undefined,
  ]) {
    assert.equal(_isEntwarnung(p), false, JSON.stringify(p));
  }
});

test('der Regex-Fallback ist entfernt (kein _isSelfCancelled-Export mehr)', () => {
  assert.equal(require('../../routes/jobs/komplett/remap.js')._isSelfCancelled, undefined);
});

// O-Ton-Enums: Browser-SSoT (public/js/sources/fields.js) und CJS-Spiegel
// (db/sources/shared.js) muessen deckungsgleich sein. Der Blockier-Satz entscheidet
// auf dem Server, ob eine Freigabe Bedenken meldet (lib/freigabe-bedenken.js), im
// Browser, ob die Quellen-Karte warnt — driften die beiden, warnt die eine Stelle
// und die andere schweigt.
//
// Lauf: `node --test tests/unit/oton-auth-drift.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const esm = await import('../../public/js/sources/fields.js');
const cjs = require('../../db/sources/shared.js');

test('O-Ton-Enums: Browser und Server deckungsgleich', () => {
  assert.deepEqual(cjs.OTON_CHANNELS, esm.OTON_CHANNELS);
  assert.deepEqual(cjs.OTON_AUTH, esm.OTON_AUTH);
  assert.deepEqual(cjs.OTON_AUTH_BLOCKING, esm.OTON_AUTH_BLOCKING);
  for (const v of cjs.OTON_AUTH_BLOCKING) assert.ok(cjs.OTON_AUTH.includes(v), v);
});

test('otonBlocking folgt dem Blockier-Satz, nur bei Interview-Quellen', () => {
  for (const auth of [...esm.OTON_AUTH, null]) {
    assert.equal(esm.otonBlocking({ csl_type: 'interview', oton_auth: auth }),
      esm.OTON_AUTH_BLOCKING.includes(auth), String(auth));
    assert.equal(esm.otonBlocking({ csl_type: 'book', oton_auth: auth }), false);
  }
});

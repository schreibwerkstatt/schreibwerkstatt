// TTL-Helfer der Komplettanalyse (routes/jobs/komplett/call.js). Die Schema-Regel für
// den geteilten 1h-Präfix testet tests/unit/claude-shared-prefix-format.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withTtl } = require('../../routes/jobs/komplett/call.js');

test('withTtl: 1h lässt die Blöcke unverändert, sonst fallen alle TTLs weg (keine 1h hinter 5m)', () => {
  const blocks = [{ text: 'Buch', ttl: '1h' }, { text: 'Kern', ttl: '1h' }, { text: 'Kontext' }];
  assert.deepEqual(withTtl(blocks, '1h'), blocks);
  const short = withTtl(blocks, '5m');
  assert.deepEqual(short, [{ text: 'Buch' }, { text: 'Kern' }, { text: 'Kontext' }]);
  assert.ok(short.every(b => !('ttl' in b)));
});

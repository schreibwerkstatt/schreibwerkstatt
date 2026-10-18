// Anfrage-Pfad des Embedding-Clients (lib/embed.js#embedQuery): eigener kurzer
// Timeout, höchstens ein Retry, Breaker nach transientem Ausfall und LRU-Cache der
// Anfrage-Vektoren. Ohne das liefe jede Suche/jeder Chat-Start bei hängendem
// Backend durch die Index-Retry-Kette (4 × embed.timeout_ms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('embed-query');

const require = createRequire(import.meta.url);
const appSettings = require('../../lib/app-settings.js');
const embed = require('../../lib/embed.js');

appSettings.set('embed.enabled', true);
appSettings.set('embed.host', 'http://embed.invalid');
appSettings.set('embed.query_timeout_ms', 2000);

const realFetch = globalThis.fetch;
let calls = 0;
function stubOk() {
  globalThis.fetch = async (url, opts) => {
    calls++;
    const { input } = JSON.parse(opts.body);
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }), { status: 200 });
  };
}
function stubDown() {
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
}
test.afterEach(() => { globalThis.fetch = realFetch; calls = 0; embed._resetQueryState(); });

test('embedQuery: gleiche Anfrage kommt aus dem Cache', async () => {
  stubOk();
  const a = await embed.embedQuery('Abschied am Bahnhof');
  const b = await embed.embedQuery('Abschied am Bahnhof');
  assert.equal(calls, 1);
  assert.deepEqual(Array.from(b), Array.from(a));
  await embed.embedQuery('etwas anderes');
  assert.equal(calls, 2);
});

test('embedQuery: höchstens ein Retry, danach Breaker ohne Netz-Aufruf', async () => {
  stubDown();
  await assert.rejects(embed.embedQuery('frage'), /nicht erreichbar/);
  assert.equal(calls, 2, 'ein Versuch + ein Retry');
  await assert.rejects(embed.embedQuery('andere frage'), (e) => e.breakerOpen === true);
  assert.equal(calls, 2, 'offener Breaker fragt den Endpunkt nicht');
});

test('embedBatch (Index-Pfad) liest den Anfrage-Breaker nicht', async () => {
  stubDown();
  await assert.rejects(embed.embedQuery('frage'));
  stubOk();
  const vecs = await embed.embedBatch(['passage']);
  assert.equal(vecs.length, 1);
});

test('embedOne force: Admin-Test geht auch bei ausgeschaltetem Backend', async () => {
  stubOk();
  appSettings.set('embed.enabled', false);
  try {
    await assert.rejects(embed.embedOne('x'), /nicht konfiguriert/);
    const v = await embed.embedOne('x', { force: true, retries: 0 });
    assert.equal(v.length, 3);
  } finally {
    appSettings.set('embed.enabled', true);
  }
});

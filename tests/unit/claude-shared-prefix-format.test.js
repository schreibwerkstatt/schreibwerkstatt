'use strict';
// Cache-Regel im Claude-Provider (lib/ai/claude.js#_isSharedPrefixSystem): beginnt das
// System mit einem 1h-gecachten Block (Buchtext der Komplettanalyse, von vielen Pässen
// geteilt), geht KEIN output_config.format mit. Structured Outputs gehören zum
// Cache-Präfix — ein anderes Schema je Pass schrieb das ganze Buch je Pass neu in den
// 1h-Cache (gemessen: ~13 Buch-Writes statt einem, 61 statt 18 USD pro Lauf).
const test = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA = { type: 'object', properties: { ok: { type: 'integer' } }, required: ['ok'], additionalProperties: false };

async function captureBody(system) {
  const origFetch = globalThis.fetch;
  process.env.API_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":1}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    delete require.cache[require.resolve('../../lib/ai')];
    const { callAI } = require('../../lib/ai');
    await callAI('hi', system, null, 100, null, 'claude', SCHEMA, { model: 'claude-opus-4-8' });
    return body;
  } finally {
    globalThis.fetch = origFetch;
    delete require.cache[require.resolve('../../lib/ai')];
  }
}

test('geteilter 1h-Präfix: kein output_config.format, Cache-Marker bleibt', async () => {
  const body = await captureBody([{ text: 'Buchtext …', ttl: '1h', sharedPrefix: true }, { text: 'Regeln' }]);
  assert.equal(body.output_config?.format, undefined);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('ohne geteilten Präfix: Schema geht als Structured Output mit', async () => {
  const body = await captureBody([{ text: 'Regeln' }]);
  assert.equal(body.output_config?.format?.type, 'json_schema');
  // SYSTEM_*_BLOCKS mit Autorenkontext beginnen mit einem 1h-Block (prompts/core.js
  // #_toCacheBlocks) — Lektorat/Review behalten trotzdem ihr Schema.
  const bodyCore = await captureBody([{ text: 'Lektorat-Kern', ttl: '1h' }, { text: 'Autorenkontext' }]);
  assert.equal(bodyCore.output_config?.format?.type, 'json_schema');
  // Standalone-Job (5-min-TTL, einziger Leser) behält sein Schema.
  const body5m = await captureBody([{ text: 'Buchtext …', sharedPrefix: true }, { text: 'Regeln' }]);
  assert.equal(body5m.output_config?.format?.type, 'json_schema');
  const bodyStr = await captureBody('System als String');
  assert.equal(bodyStr.output_config?.format?.type, 'json_schema');
});

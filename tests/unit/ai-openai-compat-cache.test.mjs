// Prompt-Cache-Treffer lokaler Server (llama.cpp über LocalAI/LiteLLM): die Antwort
// meldet sie in `usage.prompt_tokens_details.cached_tokens` (OpenAI-Form). Sie
// landen als `cacheReadIn` im Ergebnis — `tokensIn` bleibt das cache-inklusive
// Total (prompt_tokens), wie bei Claude. Kosten bleiben 0 (costUsd nur für claude).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEndpoint, sse, bootstrap } from './_helpers/openai-compat-fake.mjs';

const SYSTEM = 'Systemanweisung. '.repeat(60);
const TOOLS = [
  { name: 'final_answer', description: 'Endpunkt', input_schema: { type: 'object', properties: { antwort: { type: 'string' } }, required: ['antwort'] } },
];

test('Chat: cached_tokens aus usage wird cacheReadIn, tokensIn bleibt prompt_tokens', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { content: '{"ok":true}' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 68507, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 68484 } } },
  ]));
  const ctx = bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIChat([{ role: 'user', content: 'Frage' }], SYSTEM, null, null, null, 'openai-compat');
    assert.equal(r.tokensIn, 68507);
    assert.equal(r.cacheReadIn, 68484);
    assert.equal(r.cacheCreationIn, 0);
  } finally { ctx.teardown(); ep.close(); }
});

test('Werkzeug-Modus: cached_tokens wird cacheReadIn', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'abcdefghi', type: 'function', function: { name: 'final_answer', arguments: '{"antwort":"ok"}' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 480 } } },
  ]));
  const ctx = bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat');
    assert.equal(r.tokensIn, 500);
    assert.equal(r.cacheReadIn, 480);
  } finally { ctx.teardown(); ep.close(); }
});

test('ohne prompt_tokens_details (älterer Server): cacheReadIn 0', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { content: '{"ok":true}' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3 } },
  ]));
  const ctx = bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIChat([{ role: 'user', content: 'Frage' }], SYSTEM, null, null, null, 'openai-compat');
    assert.equal(r.cacheReadIn, 0);
  } finally { ctx.teardown(); ep.close(); }
});

test('cached_tokens grösser als prompt_tokens wird auf tokensIn gedeckelt', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { content: '{"ok":true}' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 150 } } },
  ]));
  const ctx = bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIChat([{ role: 'user', content: 'Frage' }], SYSTEM, null, null, null, 'openai-compat');
    assert.equal(r.cacheReadIn, 100);
  } finally { ctx.teardown(); ep.close(); }
});

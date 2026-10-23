// Thinking-Modus von lib/ai/openai-compat.js: Sampling (Qwen-Empfehlung statt
// niedriger Temperatur + Repeat-Penalty), Denk-Reserve auf gedeckelten Calls,
// Denkphase als Fortschritts-Signal und die Denkspur, die im Werkzeug-Modus als
// `reasoning_content` in die nächste Runde zurückgeht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEndpoint, sse, bootstrap } from './_helpers/openai-compat-fake.mjs';

const SYSTEM = 'Systemanweisung. '.repeat(60);
const TOOLS = [
  { name: 'web_search', description: 'Websuche', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

const JSON_ANSWER = [
  { choices: [{ index: 0, delta: { reasoning_content: 'Erst überlegen.\nDann antworten.' } }] },
  { choices: [{ index: 0, delta: { content: '{"ok":true}' } }] },
  { choices: [{ index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } },
];

test('ohne Thinking: konfigurierte Temperatur + repeat_penalty, enable_thinking:false, Deckel unverändert', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, JSON_ANSWER.slice(1)));
  const ctx = bootstrap(ep.url, { 'ai.openai-compat.temperature': 0.15 });
  try {
    await ctx.ai.callAI('Frage', SYSTEM, null, 2000, null, 'openai-compat');
    const b = ep.state.last;
    assert.equal(b.temperature, 0.15);
    assert.equal(b.repeat_penalty, 1.15);
    assert.equal('top_p' in b, false);
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
    assert.equal(b.max_tokens, 2000);
  } finally { ctx.teardown(); ep.close(); }
});

test('Thinking: Qwen-Sampling ohne repeat_penalty, Chat-Temperatur wird ersetzt, kein Kwarg', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, JSON_ANSWER));
  const ctx = bootstrap(ep.url, { 'ai.openai-compat.think': true, 'ai.openai-compat.temperature': 0.15 });
  try {
    const r = await ctx.ai.callAIChat([{ role: 'user', content: 'Frage' }], SYSTEM, null, null, null, 'openai-compat', null, 0.2);
    const b = ep.state.last;
    assert.equal(b.temperature, 0.6);
    assert.equal(b.top_p, 0.95);
    // top_k ist kein OpenAI-Feld — echtes OpenAI lehnte den Call ab.
    assert.equal('top_k' in b, false);
    assert.equal('repeat_penalty' in b, false);
    assert.equal('chat_template_kwargs' in b, false);
    // Die Denkspur bleibt ausserhalb des Antworttexts.
    assert.equal(r.text, '{"ok":true}');
  } finally { ctx.teardown(); ep.close(); }
});

test('Thinking: gedeckelter Call bekommt die Denk-Reserve, gedeckelt durch max_tokens_out', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, JSON_ANSWER));
  const ctx = bootstrap(ep.url, {
    'ai.openai-compat.think': true, 'ai.openai-compat.think_budget': 4000, 'ai.openai-compat.max_tokens_out': 16000,
  });
  try {
    await ctx.ai.callAI('Frage', SYSTEM, null, 2000, null, 'openai-compat');
    assert.equal(ep.state.last.max_tokens, 6000);
    await ctx.ai.callAI('Frage', SYSTEM, null, 14000, null, 'openai-compat');
    assert.equal(ep.state.last.max_tokens, 16000);
    // Ungedeckelter Call: globaler Cap, keine Reserve darüber.
    await ctx.ai.callAI('Frage', SYSTEM, null, null, null, 'openai-compat');
    assert.equal(ep.state.last.max_tokens, 16000);
  } finally { ctx.teardown(); ep.close(); }
});

test('Thinking: Denkphase meldet sich einmal als thinking, danach Text', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { reasoning_content: 'a' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'b' } }] },
    ...JSON_ANSWER.slice(1),
  ]));
  const ctx = bootstrap(ep.url, { 'ai.openai-compat.think': true });
  try {
    const events = [];
    await ctx.ai.callAI('Frage', SYSTEM, (e) => events.push(e), null, null, 'openai-compat');
    assert.equal(events.filter(e => e.thinking).length, 1);
    assert.ok(events[0].thinking, 'erstes Signal ist die Denkphase');
    assert.ok(events.some(e => !e.thinking && e.chars > 0), 'danach Text');
    // Ohne Werkzeuge keine `note` — die Statuszeile gehört dort dem Job.
    assert.equal(events.some(e => e.note), false);
  } finally { ctx.teardown(); ep.close(); }
});

test('Thinking im Werkzeug-Modus: letzte Denkzeile als note, Denkspur geht als reasoning_content zurück', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { reasoning_content: 'Was weiss ich schon?\nIch suche nach dem Eröffnungsdatum.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Gotthard"}' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 40 } },
  ]));
  const ctx = bootstrap(ep.url, { 'ai.openai-compat.think': true });
  try {
    const notes = [];
    const msgs = [{ role: 'user', content: 'Wann wurde der Gotthard-Basistunnel eröffnet?' }];
    const r = await ctx.ai.callAIWithTools(msgs, SYSTEM, TOOLS, (e) => { if (e.note) notes.push(e.note); }, null, null, 'openai-compat');
    assert.deepEqual(notes, ['Ich suche nach dem Eröffnungsdatum.']);
    assert.equal(r.stopReason, 'tool_use');
    assert.equal(r.rawContentBlocks[0].type, 'thinking');

    // Folgerunde: der Loop hängt rawContentBlocks als assistant-Turn an.
    msgs.push({ role: 'assistant', content: r.rawContentBlocks });
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1. Juni 2016' }] });
    await ctx.ai.callAIWithTools(msgs, SYSTEM, TOOLS, null, null, null, 'openai-compat');
    const assistant = ep.state.last.messages.find(m => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'Was weiss ich schon?\nIch suche nach dem Eröffnungsdatum.');
    assert.equal(assistant.tool_calls[0].function.name, 'web_search');
  } finally { ctx.teardown(); ep.close(); }
});

// Stream-Robustheit der KI-Provider:
//   • Claude: ein Timeout MITTEN im Stream (reader.read) ist AI_TIMEOUT (transient,
//     retrybar), nicht ein roher AbortError — Text- und Tool-Pfad.
//   • Claude: Overload vor dem ersten Delta wird wiederholt (withOverloadRetry).
//   • Claude: genDurationMs (Basis fuer tok/s) umfasst die Denkphase, weil
//     output_tokens die Denk-Tokens mitzaehlt.
//   • Ollama + openai-compat: Fehler-Chunks im Stream werfen mit der Server-Meldung
//     statt still mit leerem Text zu enden; Ollama hat einen Hard-Timeout.
//   • Semaphore/Lock: wartende Aufrufer sind per Signal abbrechbar.
//
// Lauf: `node --test tests/unit/ai-provider-streams.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'ai-streams-')), 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const { runWithContext } = require('../../lib/log-context');
const { _callClaude, _callClaudeWithTools } = require('../../lib/ai/claude');
const { _callOllama } = require('../../lib/ai/ollama');
const { _callOpenAICompat } = require('../../lib/ai/openai-compat');
const { makeSemaphore, makeLock } = require('../../lib/ai/shared');

const realFetch = globalThis.fetch;
const PROMPT = [{ role: 'user', content: 'Bitte antworte. '.repeat(40) }];

// Body, dessen Reader nie liefert, bis das Signal abbricht.
function hangingStreamResponse(signal) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        cancel: async () => {},
      }),
    },
  };
}

function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const withShortClaudeTimeout = (fn) => runWithContext({ aiJob: { provider: 'claude', timeoutMs: 60 } }, fn);

test('Claude Text-Pfad: Timeout mitten im Stream → AI_TIMEOUT mit i18n-Key', async () => {
  globalThis.fetch = async (_url, opts) => hangingStreamResponse(opts.signal);
  try {
    await assert.rejects(withShortClaudeTimeout(() => _callClaude(PROMPT, 'sys', null, null, null)),
      (e) => e.code === 'AI_TIMEOUT' && e.message === 'job.error.aiTimeout' && e.i18nParams?.provider === 'Claude');
  } finally { globalThis.fetch = realFetch; }
});

test('Claude Tool-Pfad: Timeout mitten im Stream → AI_TIMEOUT', async () => {
  globalThis.fetch = async (_url, opts) => hangingStreamResponse(opts.signal);
  try {
    await assert.rejects(withShortClaudeTimeout(() => _callClaudeWithTools(PROMPT, 'sys', [], null, null, null)),
      (e) => e.code === 'AI_TIMEOUT');
  } finally { globalThis.fetch = realFetch; }
});

test('Claude: User-Abbruch mitten im Stream bleibt Abbruch, kein AI_TIMEOUT', async () => {
  const ctrl = new AbortController();
  globalThis.fetch = async (_url, opts) => { setTimeout(() => ctrl.abort(), 10); return hangingStreamResponse(opts.signal); };
  try {
    await assert.rejects(_callClaude(PROMPT, 'sys', null, null, ctrl.signal), (e) => e.code !== 'AI_TIMEOUT');
  } finally { globalThis.fetch = realFetch; }
});

test('Claude: Overload (529) vor dem ersten Delta wird wiederholt, dann Text + Usage', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{"error":{"type":"overloaded_error"}}', { status: 529, headers: { 'retry-after': '1' } });
    return sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'true}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    ]);
  };
  try {
    const r = await _callClaude(PROMPT, 'sys', null, null, null);
    assert.equal(calls, 2);
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.tokensIn, 15);
    assert.equal(r.tokensOut, 7);
    assert.equal(r.stopReason, 'end_turn');
  } finally { globalThis.fetch = realFetch; }
});

// SSE-Stream, der zwischen Event-Gruppen echte Pausen macht.
function pacedSseResponse(groups, pauseMs) {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i >= groups.length) { ctrl.close(); return; }
      if (i > 0) await new Promise((r) => setTimeout(r, pauseMs));
      ctrl.enqueue(enc.encode(groups[i++].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('Claude: genDurationMs umfasst die Denkphase (display omitted), nicht nur die Textzeit', async () => {
  globalThis.fetch = async () => pacedSseResponse([
    [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ],
    [
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"ok":true}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
    ],
  ], 60);
  try {
    const r = await _callClaude(PROMPT, 'sys', null, null, null);
    assert.equal(r.text, '{"ok":true}');
    assert.ok(r.genDurationMs >= 50, `genDurationMs=${r.genDurationMs} deckt die Denkphase nicht ab`);
  } finally { globalThis.fetch = realFetch; }
});

test('Claude Tool-Pfad: tool_use-Input wird aus Deltas zusammengesetzt', async () => {
  globalThis.fetch = async () => sseResponse([
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'list_chapters' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
  ]);
  try {
    const r = await _callClaudeWithTools(PROMPT, 'sys', [], null, null, null);
    assert.deepEqual(r.toolUses, [{ id: 't1', name: 'list_chapters', input: { a: 1 } }]);
    assert.equal(r.stopReason, 'tool_use');
    assert.deepEqual(r.rawContentBlocks, [{ type: 'tool_use', id: 't1', name: 'list_chapters', input: { a: 1 } }]);
  } finally { globalThis.fetch = realFetch; }
});

async function fakeServer(handler) {
  const srv = createServer((req, res) => { req.resume(); req.on('end', () => handler(res)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

test('openai-compat: Fehler-Chunk im SSE-Stream wirft mit der Server-Meldung', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hal' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ error: { message: 'context length exceeded', code: 400 } })}\n\n`);
    res.end();
  });
  appSettings.set('ai.openai-compat.host', ep.url, 'test@example.com');
  appSettings.set('ai.openai-compat.retry_max', 1, 'test@example.com');
  try {
    await assert.rejects(_callOpenAICompat(PROMPT, 'sys', null, null, null),
      (e) => e.message === 'job.error.aiStreamError' && /context length exceeded/.test(e.i18nParams?.detail));
  } finally { ep.close(); }
});

test('Ollama: Fehler-Chunk im NDJSON-Stream wirft mit der Server-Meldung', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ error: 'model requires more system memory' }) + '\n');
    res.end();
  });
  appSettings.set('ai.ollama.host', ep.url, 'test@example.com');
  try {
    await assert.rejects(_callOllama(PROMPT, 'sys', null, null, null),
      (e) => e.message === 'job.error.aiStreamError' && /more system memory/.test(e.i18nParams?.detail));
  } finally { ep.close(); }
});

test('Ollama: Hard-Timeout ueber den Stream → AI_TIMEOUT', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'x' } }) + '\n'); // dann Stille
  });
  appSettings.set('ai.ollama.host', ep.url, 'test@example.com');
  appSettings.set('ai.ollama.timeout_ms', 1000, 'test@example.com');
  try {
    await assert.rejects(_callOllama(PROMPT, 'sys', null, null, null),
      (e) => e.code === 'AI_TIMEOUT' && e.i18nParams?.provider === 'Ollama');
  } finally { ep.close(); }
});

test('Semaphore: wartender Aufrufer ist abbrechbar und verlaesst die Warteschlange', async () => {
  const withSlot = makeSemaphore(() => 1);
  let release;
  const first = withSlot(() => new Promise((r) => { release = r; }));
  const ctrl = new AbortController();
  let ranSecond = false;
  const second = withSlot(async () => { ranSecond = true; }, ctrl.signal);
  const third = withSlot(async () => 'drei');
  ctrl.abort();
  await assert.rejects(second, (e) => e.name === 'AbortError');
  release('eins');
  assert.equal(await first, 'eins');
  assert.equal(await third, 'drei');
  assert.equal(ranSecond, false);
});

test('Lock: bereits abgebrochenes Signal startet fn gar nicht', async () => {
  const withLock = makeLock();
  const ctrl = new AbortController();
  ctrl.abort();
  let ran = false;
  await assert.rejects(withLock(async () => { ran = true; }, ctrl.signal), (e) => e.name === 'AbortError');
  assert.equal(ran, false);
  assert.equal(await withLock(async () => 42), 42);
});

// Streams ohne Endmarke + Provider-Fehler als i18n-Key (lib/ai/*):
//   • Claude ohne stop_reason/message_stop, Ollama ohne `done`-Chunk und
//     openai-compat ohne finish_reason/[DONE] gelten als unvollständig
//     (truncated=true) — der Aufrufer wirft, statt ein jsonrepair-Teilstück zu
//     verbuchen. Vollständige Streams bleiben unberührt.
//   • HTTP-/Stream-Fehler tragen einen i18n-Key + Params (provider, status,
//     detail), nie rohen Provider-Text als message.
//   • parseJSON wirft `job.error.parseFailed` (Notify-Skip-Liste matcht).
//
// Lauf: `node --test tests/unit/ai-stream-incomplete.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ai-incomplete');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const { _callClaude } = require('../../lib/ai/claude');
const { _callOllama } = require('../../lib/ai/ollama');
const { _callOpenAICompat } = require('../../lib/ai/openai-compat');
const { parseJSON, PARSE_FAILED_KEY } = require('../../lib/ai/parse');

const realFetch = globalThis.fetch;
const PROMPT = [{ role: 'user', content: 'Bitte antworte. '.repeat(40) }];
const by = { updatedBy: 'test@example.com' };

function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const START = { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 10 } } };
const TEXT = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"a":[1,2' } };

test('Claude: Stream endet ohne stop_reason → truncated', async () => {
  globalThis.fetch = async () => sseResponse([START, TEXT]);
  try {
    const r = await _callClaude(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, true);
  } finally { globalThis.fetch = realFetch; }
});

test('Claude: vollständiger Stream (stop_reason end_turn) bleibt nicht truncated', async () => {
  globalThis.fetch = async () => sseResponse([START, TEXT,
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' }]);
  try {
    const r = await _callClaude(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, false);
  } finally { globalThis.fetch = realFetch; }
});

test('Claude: HTTP-Fehler → job.error.aiHttpError mit status + detail', async () => {
  globalThis.fetch = async () => new Response('{"type":"error","error":{"type":"not_found_error","message":"model: x"}}', { status: 404 });
  try {
    await assert.rejects(_callClaude(PROMPT, 'sys', null, null, null), (e) =>
      e.message === 'job.error.aiHttpError' && e.i18nParams.provider === 'Claude'
      && e.i18nParams.status === 404 && /not_found_error/.test(e.i18nParams.detail) && e.status === undefined);
  } finally { globalThis.fetch = realFetch; }
});

test('Claude: HTTP 401/403 → job.error.aiAuthFailed statt roher Provider-JSON', async () => {
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response('{"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}}', { status });
    try {
      await assert.rejects(_callClaude(PROMPT, 'sys', null, null, null), (e) =>
        e.message === 'job.error.aiAuthFailed' && e.i18nParams.provider === 'Claude'
        && e.i18nParams.status === status && /authentication_error/.test(e.detail));
    } finally { globalThis.fetch = realFetch; }
  }
});

test('Claude: Fehler-Event im Stream → job.error.aiStreamError', async () => {
  globalThis.fetch = async () => sseResponse([START, { type: 'error', error: { type: 'api_error', message: 'boom' } }]);
  try {
    await assert.rejects(_callClaude(PROMPT, 'sys', null, null, null), (e) =>
      e.message === 'job.error.aiStreamError' && /boom/.test(e.i18nParams.detail));
  } finally { globalThis.fetch = realFetch; }
});

async function fakeServer(handler) {
  const srv = createServer((req, res) => { req.resume(); req.on('end', () => handler(res)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

test('Ollama: Stream endet ohne done-Chunk → truncated', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { content: '{"a":[1' } }) + '\n');
  });
  appSettings.set('ai.ollama.host', ep.url, by);
  try {
    const r = await _callOllama(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, true);
    assert.equal(r.incomplete, true);
  } finally { ep.close(); }
});

test('Ollama: mit done-Chunk vollständig', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: '{"a":1}' } }) + '\n');
    res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 }) + '\n');
  });
  appSettings.set('ai.ollama.host', ep.url, by);
  try {
    const r = await _callOllama(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, false);
    assert.equal(r.text, '{"a":1}');
  } finally { ep.close(); }
});

test('Ollama: HTTP-Fehler → job.error.aiHttpError', async () => {
  const ep = await fakeServer((res) => { res.writeHead(404); res.end('model "x" not found'); });
  appSettings.set('ai.ollama.host', ep.url, by);
  try {
    await assert.rejects(_callOllama(PROMPT, 'sys', null, null, null), (e) =>
      e.message === 'job.error.aiHttpError' && e.i18nParams.status === 404 && /not found/.test(e.i18nParams.detail));
  } finally { ep.close(); }
});

test('openai-compat: Stream ohne finish_reason und [DONE] → truncated', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a":[1' } }] })}\n\n`);
  });
  appSettings.set('ai.openai-compat.host', ep.url, by);
  try {
    const r = await _callOpenAICompat(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, true);
  } finally { ep.close(); }
});

test('openai-compat: finish_reason stop → vollständig', async () => {
  const ep = await fakeServer((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a":1}' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  appSettings.set('ai.openai-compat.host', ep.url, by);
  try {
    const r = await _callOpenAICompat(PROMPT, 'sys', null, null, null);
    assert.equal(r.truncated, false);
  } finally { ep.close(); }
});

test('openai-compat: HTTP 400 → job.error.aiHttpError', async () => {
  const ep = await fakeServer((res) => { res.writeHead(400); res.end('bad model'); });
  appSettings.set('ai.openai-compat.host', ep.url, by);
  try {
    await assert.rejects(_callOpenAICompat(PROMPT, 'sys', null, null, null), (e) =>
      e.message === 'job.error.aiHttpError' && e.i18nParams.status === 400 && e.i18nParams.detail === 'bad model');
  } finally { ep.close(); }
});

test('parseJSON: unrettbarer Text → job.error.parseFailed mit pos/len, Detail nicht in message', () => {
  assert.equal(PARSE_FAILED_KEY, 'job.error.parseFailed');
  assert.throws(() => parseJSON('{"a": "x" "b": ]]] {{'), (e) =>
    e.message === 'job.error.parseFailed' && e.code === 'AI_PARSE_FAILED'
    && typeof e.i18nParams.len === 'number' && typeof e.detail === 'string');
});

test('Notify-Skip-Default enthält den Key, den parseJSON wirft', () => {
  const def = String(appSettings.get('mail.notify.skip_errors')).split(',');
  assert.ok(def.includes(PARSE_FAILED_KEY));
});

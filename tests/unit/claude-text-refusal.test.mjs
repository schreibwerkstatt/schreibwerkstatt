// Claude-Text-Pfad (lib/ai/claude.js#_callClaude) bei Ablehnungen, gegen einen gemockten
// SSE-Stream:
//   • Request: serverseitiger Refusal-Fallback (Feld + Beta) wie im Werkzeug-Pfad; lehnt
//     die API ihn ab, läuft der Call einmal ohne und danach bis zum Neustart ohne.
//   • Antwort: Modellwechsel mitten in der Antwort verwirft den Text davor (sonst stünde
//     ein Satz des ablehnenden Modells vor dem JSON); das bedienende Modell kommt zurück.
//   • aiCall: stop_reason 'refusal' wird `job.error.aiRefusal` statt eines Parse-Fehlers.
//   • aiCall: leerer Text bei regulärem Ende wird `job.error.aiEmpty` (mit stop_reason).
//
// Lauf: `node --test tests/unit/claude-text-refusal.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'claude-text-')), 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const { runWithContext } = require('../../lib/log-context');
const { _callClaude, _resetFallbackRejected } = require('../../lib/ai/claude');

const realFetch = globalThis.fetch;
const MSG = [{ role: 'user', content: 'Gib JSON' }];

function sse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const start = (model = 'claude-opus-5-5') => ({ type: 'message_start', message: { model, usage: { input_tokens: 10 } } });
const stop = (reason, details = null) => ({ type: 'message_delta', delta: { stop_reason: reason, ...(details ? { stop_details: details } : {}) }, usage: { output_tokens: 5 } });
const blockStart = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const textDelta = (index, text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index) => ({ type: 'content_block_stop', index });
const END = [start(), blockStart(0, { type: 'text', text: '' }), textDelta(0, '{"a":1}'), blockStop(0), stop('end_turn')];

async function run(events, model = 'claude-opus-5-5') {
  let req = null;
  globalThis.fetch = async (_url, opts) => {
    req = { body: JSON.parse(opts.body), beta: opts.headers['anthropic-beta'] };
    return sse(events);
  };
  try {
    const result = await runWithContext({ aiJob: { provider: 'claude', model } },
      () => _callClaude(MSG, 'sys', null, null, null));
    return { req, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('Request: Refusal-Fallback mit Beta auf Opus 5.5, nicht auf Opus 4.8', async () => {
  const { req } = await run(END);
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.beta, /server-side-fallback-2026-07-01/);
  const { req: older } = await run(END, 'claude-opus-4-8');
  assert.equal('fallbacks' in older.body, false);
  assert.doesNotMatch(older.beta, /server-side-fallback/);
});

test('Antwort: Modellwechsel mitten in der Antwort verwirft den Text davor', async () => {
  const { result } = await run([
    start('claude-opus-5-5'),
    blockStart(0, { type: 'text', text: '' }), textDelta(0, 'Ich kann das nicht'), blockStop(0),
    blockStart(1, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }), blockStop(1),
    blockStart(2, { type: 'text', text: '' }), textDelta(2, '{"a":1}'), blockStop(2),
    stop('end_turn'),
  ]);
  assert.equal(result.text, '{"a":1}');
});

test('Antwort: Ablehnung liefert stopReason + stopDetails', async () => {
  const { result } = await run([start(), stop('refusal', { category: 'violence', explanation: 'x' })]);
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.stopDetails.category, 'violence');
  assert.equal(result.text, '');
});

test('Request: API lehnt den Fallback ab (400) → einmal ohne, danach bis zum Neustart ohne', async () => {
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if ('fallbacks' in body) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not enabled for this organization' } }), { status: 400 });
    }
    return sse(END);
  };
  try {
    const ctx = { aiJob: { provider: 'claude', model: 'claude-opus-5-5' } };
    const r = await runWithContext(ctx, () => _callClaude(MSG, 'sys', null, null, null));
    assert.equal(r.text, '{"a":1}');
    await runWithContext(ctx, () => _callClaude(MSG, 'sys', null, null, null));
    assert.deepEqual(bodies.map(b => 'fallbacks' in b), [true, false, false]);
  } finally {
    globalThis.fetch = realFetch;
    _resetFallbackRejected();
  }
});

test('aiCall: stop_reason refusal → job.error.aiRefusal', async () => {
  appSettings.set('ai.provider', 'claude');
  const { aiCall } = require('../../routes/jobs/shared/ai');
  globalThis.fetch = async () => sse([start(), stop('refusal', { category: 'violence' })]);
  try {
    await assert.rejects(
      runWithContext({ aiJob: { provider: 'claude', model: 'claude-opus-5-5' } },
        () => aiCall('job-x', { in: 0, out: 0, ms: 0 }, 'Gib JSON', 'sys', 0, 1, null, 0.2, 1000, 'claude')),
      (e) => e.message === 'job.error.aiRefusal',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('aiCall: leere Antwort mit end_turn → job.error.aiEmpty mit stop_reason', async () => {
  appSettings.set('ai.provider', 'claude');
  const { aiCall } = require('../../routes/jobs/shared/ai');
  globalThis.fetch = async () => sse([start(), blockStart(0, { type: 'text', text: '' }), textDelta(0, '  \n'), blockStop(0), stop('end_turn')]);
  try {
    await assert.rejects(
      runWithContext({ aiJob: { provider: 'claude', model: 'claude-opus-5-5' } },
        () => aiCall('job-x', { in: 0, out: 0, ms: 0 }, 'Gib JSON', 'sys', 0, 1, null, 0.2, 1000, 'claude')),
      (e) => e.message === 'job.error.aiEmpty' && e.i18nParams?.stop === 'end_turn',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

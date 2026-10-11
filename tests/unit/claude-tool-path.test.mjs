// Claude-Tool-Pfad (lib/ai/claude.js#_callClaudeWithTools + lib/ai/claude-tool-blocks.js)
// gegen einen gemockten SSE-Stream:
//   • Request: display 'summarized', serverseitiger Refusal-Fallback (Feld + Beta,
//     nur auf freigegebenen Modellen, abschaltbar), eager_input_streaming nur auf
//     final_answer.
//   • Antwort: refusal + stop_details, unbekannte Blöcke verbatim, Echo-Regeln nach
//     einem Modellwechsel mitten in der Antwort, bedienendes Modell, Zwischenstand
//     aus der Thinking-Zusammenfassung.
//
// Lauf: `node --test tests/unit/claude-tool-path.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'claude-tools-')), 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const { runWithContext } = require('../../lib/log-context');
const { _callClaudeWithTools, _resetFallbackRejected } = require('../../lib/ai/claude');
const { progressNote } = require('../../lib/ai/claude-tool-blocks');

const realFetch = globalThis.fetch;
const PROMPT = [{ role: 'user', content: 'Frage' }];
const TOOLS = [
  { name: 'lookup', description: 'x', input_schema: { type: 'object', properties: {} } },
  { name: 'final_answer', description: 'y', input_schema: { type: 'object', properties: {} } },
];

function sse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const start = (model = 'claude-opus-5-5') => ({ type: 'message_start', message: { model, usage: { input_tokens: 10 } } });
const stop = (reason, details = null) => ({ type: 'message_delta', delta: { stop_reason: reason, ...(details ? { stop_details: details } : {}) }, usage: { output_tokens: 5 } });
const blockStart = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const delta = (index, d) => ({ type: 'content_block_delta', index, delta: d });
const blockStop = (index) => ({ type: 'content_block_stop', index });

async function run(events, { model = 'claude-opus-5-5', onProgress = null } = {}) {
  let req = null;
  globalThis.fetch = async (_url, opts) => {
    req = { body: JSON.parse(opts.body), beta: opts.headers['anthropic-beta'] };
    return sse(events);
  };
  try {
    const result = await runWithContext({ aiJob: { provider: 'claude', model } },
      () => _callClaudeWithTools(PROMPT, 'sys', TOOLS, onProgress, null, null));
    return { req, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const END = [start(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'ok' }), blockStop(0), stop('end_turn')];

test('Request: display summarized, Refusal-Fallback mit Beta, eager_input_streaming nur auf final_answer', async () => {
  const { req } = await run(END);
  assert.deepEqual(req.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.beta, /server-side-fallback-2026-07-01/);
  const byName = Object.fromEntries(req.body.tools.map(t => [t.name, t]));
  assert.equal(byName.final_answer.eager_input_streaming, true);
  assert.equal('eager_input_streaming' in byName.lookup, false);
});

test('Request: Fallback abgeschaltet oder Modell ohne Fallback → weder Feld noch Beta', async () => {
  appSettings.set('ai.claude.refusal_fallback', false);
  try {
    const { req } = await run(END);
    assert.equal('fallbacks' in req.body, false);
    assert.doesNotMatch(req.beta, /server-side-fallback/);
  } finally {
    appSettings.set('ai.claude.refusal_fallback', true);
  }
  const { req: older } = await run(END, { model: 'claude-opus-4-8' });
  assert.equal('fallbacks' in older.body, false);
  assert.doesNotMatch(older.beta, /server-side-fallback/);
  const { req: classic } = await run(END, { model: 'claude-sonnet-4-6' });
  assert.equal('thinking' in classic.body, false, 'Modelle ohne adaptives Denken bekommen kein thinking-Feld');
});

test('Antwort: refusal liefert stopReason + stopDetails', async () => {
  const { result } = await run([start(), stop('refusal', { type: 'refusal', category: 'bio', explanation: null })]);
  assert.equal(result.stopReason, 'refusal');
  assert.equal(result.stopDetails.category, 'bio');
  assert.deepEqual(result.toolUses, []);
});

test('Antwort: unbekannter Blocktyp geht verbatim in die nächste Runde', async () => {
  const unknown = { type: 'web_fetch_tool_result', tool_use_id: 's1', content: { type: 'web_fetch_result', url: 'https://x' } };
  const { result } = await run([
    start(),
    blockStart(0, { type: 'server_tool_use', id: 's1', name: 'web_fetch' }),
    delta(0, { type: 'input_json_delta', partial_json: '{"url":"https://x"}' }),
    blockStop(0),
    blockStart(1, unknown), blockStop(1),
    blockStart(2, { type: 'tool_use', id: 't1', name: 'lookup' }),
    delta(2, { type: 'input_json_delta', partial_json: '{}' }),
    blockStop(2),
    stop('tool_use'),
  ]);
  assert.deepEqual(result.rawContentBlocks.map(b => b.type), ['server_tool_use', 'web_fetch_tool_result', 'tool_use']);
  assert.deepEqual(result.rawContentBlocks[1], unknown);
  assert.deepEqual(result.toolUses.map(t => t.id), ['t1']);
});

test('Antwort: Modellwechsel mitten in der Antwort — Blöcke des abgelehnten Versuchs fallen weg', async () => {
  const { result } = await run([
    start('claude-opus-5-5'),
    blockStart(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'signature_delta', signature: 'sig' }), blockStop(0),
    blockStart(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'Ich prüfe ' }), blockStop(1),
    blockStart(2, { type: 'tool_use', id: 'old', name: 'lookup' }), delta(2, { type: 'input_json_delta', partial_json: '{"q":' }), blockStop(2),
    blockStart(3, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }), blockStop(3),
    blockStart(4, { type: 'tool_use', id: 'new', name: 'lookup' }), delta(4, { type: 'input_json_delta', partial_json: '{}' }), blockStop(4),
    stop('tool_use'),
  ]);
  assert.deepEqual(result.rawContentBlocks.map(b => b.type), ['text', 'fallback', 'tool_use']);
  assert.deepEqual(result.toolUses.map(t => t.id), ['new'], 'der abgelehnte tool_use wird nie ausgeführt');
});

test('Antwort: bedienendes Modell aus message_start (Fallback vor dem ersten Output)', async () => {
  const { result } = await run([start('claude-opus-5'), ...END.slice(1)]);
  assert.equal(result.model, 'claude-opus-5');
});

test('Antwort: abgeschlossene Thinking-Zusammenfassung → onProgress({ note })', async () => {
  const notes = [];
  await run([
    start(),
    blockStart(0, { type: 'thinking', thinking: '' }),
    delta(0, { type: 'thinking_delta', thinking: '**Alter prüfen**\n\nIch prüfe jetzt Manuels Geburtsjahr.' }),
    delta(0, { type: 'signature_delta', signature: 's' }),
    blockStop(0),
    ...END.slice(1),
  ], { onProgress: (p) => { if (p.note) notes.push(p.note); } });
  assert.deepEqual(notes, ['Ich prüfe jetzt Manuels Geburtsjahr.']);
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
    const r = await runWithContext(ctx, () => _callClaudeWithTools(PROMPT, 'sys', TOOLS, null, null, null));
    assert.equal(r.text, 'ok');
    await runWithContext(ctx, () => _callClaudeWithTools(PROMPT, 'sys', TOOLS, null, null, null));
    assert.deepEqual(bodies.map(b => 'fallbacks' in b), [true, false, false]);
  } finally {
    globalThis.fetch = realFetch;
    _resetFallbackRejected();
  }
});

test('progressNote: letzte Zeile, Markdown-Präfixe weg, gedeckelt', () => {
  assert.equal(progressNote('- erster Punkt\n## Nächster Schritt'), 'Nächster Schritt');
  assert.equal(progressNote(''), '');
  assert.equal(progressNote('x'.repeat(300)).length, 160);
});

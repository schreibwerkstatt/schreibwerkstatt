// Lektorat-Modell + -Effort + Denk-Status.
//
// Auf Modellen mit adaptivem Denken (Sonnet 5+, Opus 4.7+) waehlt die API ohne
// Effort-Feld 'high': das Seiten-Lektorat denkt dann pro Pass Zehntausende Tokens
// stumm, der Stream liefert minutenlang nur Pings, und der Job steht sichtbar bei
// 10 %. `applyLektoratAiOverrides` bindet deshalb `ai.claude.effort.lektorat` — aber nur
// dort; Sonnet 4.6 (kein Thinking) bleibt unberuehrt. Dieselbe Funktion routet
// `ai.claude.model.lektorat`; der Effort richtet sich nach DIESEM Modell. Der Denk-Block selbst wird
// ueber `tok.onThinking` gemeldet, damit die Statuszeile ihn anzeigen kann.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'lektorat-effort-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    appSettings: require_('../../lib/app-settings'),
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    split: require_('../../routes/jobs/lektorat-split'),
    jobsAi: require_('../../routes/jobs/shared/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

// `ai.claude.model` global setzen und das Lektorat darauf laufen lassen.
function _globalModel(appSettings, model) {
  appSettings.set('ai.claude.model', model, { updatedBy: 'test' });
}

test('applyLektoratAiOverrides: Sonnet 5 bekommt den Default-Effort medium im Job-Bag', () => {
  const { split, cfg, appSettings, logCtx, teardown } = _bootstrap();
  try {
    _globalModel(appSettings, 'claude-sonnet-5');
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.deepEqual(split.applyLektoratAiOverrides('claude', quietLogger), { model: 'claude-sonnet-5', cacheSuffix: ':e=medium' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', effort: 'medium' });
      assert.deepEqual(cfg._claudeOutputConfigParams('claude-sonnet-5'), { output_config: { effort: 'medium' } });
    });
  } finally { teardown(); }
});

test('applyLektoratAiOverrides: Sonnet 4.6 und fremde Provider bleiben ohne Bag', () => {
  const { split, appSettings, logCtx, teardown } = _bootstrap();
  try {
    _globalModel(appSettings, 'claude-sonnet-4-6');
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.deepEqual(split.applyLektoratAiOverrides('claude', quietLogger), { model: 'claude-sonnet-4-6', cacheSuffix: '' });
      assert.equal(split.applyLektoratAiOverrides('openai-compat', quietLogger).cacheSuffix, '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('applyLektoratAiOverrides: leerer Effort-Wert = kein Effort-Feld', () => {
  const { split, appSettings, logCtx, teardown } = _bootstrap();
  try {
    _globalModel(appSettings, 'claude-sonnet-5');
    appSettings.set('ai.claude.effort.lektorat', '', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.equal(split.applyLektoratAiOverrides('claude', quietLogger).cacheSuffix, '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

// Das Lektorat-Modell schlaegt das globale — und der Effort richtet sich nach dem
// Lektorat-Modell, nicht nach dem globalen: global Sonnet 4.6 (denkt nicht) +
// Lektorat Opus 5.5 (denkt) muss den Effort senden.
test('applyLektoratAiOverrides: ai.claude.model.lektorat routet Modell + Effort', () => {
  const { split, cfg, appSettings, logCtx, teardown } = _bootstrap();
  try {
    _globalModel(appSettings, 'claude-sonnet-4-6');
    appSettings.set('ai.claude.model.lektorat', 'claude-opus-5-5', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.deepEqual(split.applyLektoratAiOverrides('claude', quietLogger), { model: 'claude-opus-5-5', cacheSuffix: ':e=medium' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
      assert.equal(cfg._resolveClaudeModel(), 'claude-opus-5-5');
    });
    // Ausserhalb des Job-Kontexts bleibt das globale Modell unberuehrt.
    assert.equal(cfg._resolveClaudeModel(), 'claude-sonnet-4-6');
  } finally { teardown(); }
});

test('applyLektoratAiOverrides: Lektorat-Modell ohne Denken setzt nur das Modell', () => {
  const { split, appSettings, logCtx, teardown } = _bootstrap();
  try {
    _globalModel(appSettings, 'claude-sonnet-5');
    appSettings.set('ai.claude.model.lektorat', 'claude-sonnet-4-6', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'check' }, () => {
      assert.deepEqual(split.applyLektoratAiOverrides('claude', quietLogger), { model: 'claude-sonnet-4-6', cacheSuffix: '' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', model: 'claude-sonnet-4-6' });
    });
  } finally { teardown(); }
});

test('aiCall meldet den Thinking-Block über tok.onThinking (an bei Block-Start, aus beim ersten Text)', async () => {
  const origFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { jobsAi, teardown } = _bootstrap();
  globalThis.fetch = async () => new Response([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    'data: {"type":"ping"}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"fehler\\":[]}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const events = [];
    const tok = { in: 0, out: 0, ms: 0, onThinking: (_id, on) => events.push(on) };
    const res = await jobsAi.aiCall('no-job', tok, 'prompt', 'sys', null, null, 3000, 0.2, 1000, 'claude');
    assert.deepEqual(res, { fehler: [] });
    assert.deepEqual(events, [true, false]);
  } finally {
    globalThis.fetch = origFetch;
    teardown();
  }
});

// Während des Denkens streamt Claude keinen Text — der Balken muss trotzdem
// zeitbasiert vorrücken (Timer in aiCall), statt bis zum ersten Text stillzustehen.
test('aiCall: Fortschrittsbalken rückt in der Denkphase ohne Text-Events vor', async () => {
  const origFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { jobsAi, teardown } = _bootstrap();
  const shared = require_('../../routes/jobs/shared');
  const enc = new TextEncoder();
  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n'));
      ctrl.enqueue(enc.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n'));
      await gate;
      ctrl.enqueue(enc.encode([
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\\"fehler\\":[]}"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
        'data: [DONE]', '',
      ].join('\n')));
      ctrl.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const jobId = shared.createJob('check', null, null, null);
    shared.jobs.get(jobId).status = 'running';   // updateJob schreibt nur laufende Jobs
    const tok = { in: 0, out: 0, ms: 0 };
    const call = jobsAi.aiCall(jobId, tok, 'prompt', 'sys', 10, 90, 3000, 0.2, 1000, 'claude');
    await new Promise(r => setTimeout(r, 2300));
    const during = shared.jobs.get(jobId).progress;
    release();
    assert.deepEqual(await call, { fehler: [] });
    assert.ok(during > 10 && during < 90, `Balken während des Denkens: ${during}`);
  } finally {
    globalThis.fetch = origFetch;
    teardown();
  }
});

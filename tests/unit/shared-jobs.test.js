'use strict';
// Tests für routes/jobs/shared.js:
//  - aiCall: wirft i18nError wenn callAI {truncated:true} liefert (verhindert
//    «silent partial»-Bug, bei dem jsonrepair Partial-JSON zurückliefert)
//  - findActiveJobId: matcht nur queued/running, ignoriert done/error/cancelled
//
// Lädt shared.js mit gestubbtem lib/ai-Modul und temporärer DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Test-DB in tmpfs, damit kein schreibwerkstatt.db angefasst wird.
const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('test');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// Kein API_PROVIDER → defaults auf claude (kein Netzwerk – wir stubben callAI ohnehin).

// lib/ai stubben BEVOR shared.js geladen wird. parseJSON muss spy-bar sein,
// damit der Test verifizieren kann, dass es bei truncated:true NICHT aufgerufen wird.
// Pflicht-Vorlauf: db/migrations erzeugt die Tabellen, die lib/app-settings
// beim Modul-Load via prepare() aufmacht (sonst SqliteError: no such table).
require('../../db/migrations');
const aiPath = require.resolve('../../lib/ai');
const realAi = require(aiPath);
let parseCalls = 0;
let mockResult = null;
require.cache[aiPath].exports = {
  ...realAi,
  callAI: async () => mockResult,
  parseJSON: (text) => { parseCalls++; return realAi.parseJSON(text); },
};

const shared = require('../../routes/jobs/shared');

// Test-User in app_users seeden, sonst kracht FK-Constraint in insertJobRun
// (job_runs.user_email REFERENCES app_users(email)).
const { db } = require('../../db/connection');
const seedUser = db.prepare(`INSERT OR IGNORE INTO app_users (email) VALUES (?)`);
for (const email of ['u@x', 'u1@x', 'u2@x', 'u3@x', 'u4@x', 'u5@x', 'alice@x', 'bob@x']) {
  seedUser.run(email);
}

// ── aiCall: truncated → throw vor parseJSON ─────────────────────────────────
test('aiCall: truncated=true wirft i18nError VOR parseJSON', async () => {
  const jobId = shared.createJob('test', 'b1', 'u@x', null);
  // Job auf running setzen, damit updateJob die Felder schreibt.
  const jobs = shared.jobs;
  jobs.get(jobId).status = 'running';
  parseCalls = 0;
  mockResult = {
    text: '{"fehler":[{"a":1}', // bewusst Partial-JSON – jsonrepair würde es reparieren
    truncated: true,
    tokensIn: 1000,
    tokensOut: 16000,
    genDurationMs: 1200,
  };
  const tok = { in: 0, out: 0, ms: 0 };
  await assert.rejects(
    shared.aiCall(jobId, tok, 'prompt', 'system'),
    err => {
      assert.equal(err.message, 'job.error.aiTruncated');
      assert.equal(err.i18nParams.tokOut, 16000);
      return true;
    },
  );
  assert.equal(parseCalls, 0,
    'parseJSON darf bei truncated NICHT aufgerufen werden – sonst liefert jsonrepair Partial-Daten');
});

test('aiCall: truncated=false → parseJSON wird normal ausgeführt', async () => {
  const jobId = shared.createJob('test', 'b2', 'u@x', null);
  shared.jobs.get(jobId).status = 'running';
  parseCalls = 0;
  mockResult = {
    text: '{"fehler":[]}',
    truncated: false,
    tokensIn: 100, tokensOut: 50, genDurationMs: 300,
  };
  const tok = { in: 0, out: 0, ms: 0 };
  const out = await shared.aiCall(jobId, tok, 'prompt', 'system');
  assert.deepEqual(out, { fehler: [] });
  assert.equal(parseCalls, 1);
});

// ── findActiveJobId: nur aktive Jobs matchen ────────────────────────────────
test('findActiveJobId: queued-Job → matcht', () => {
  const id = shared.createJob('lektorat', 'pageX', 'u1@x', null);
  // createJob setzt status='queued'
  assert.equal(shared.findActiveJobId('lektorat', 'pageX', 'u1@x'), id);
});

test('findActiveJobId: running-Job → matcht', () => {
  const id = shared.createJob('check', 'pageY', 'u2@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('check', 'pageY', 'u2@x'), id);
});

test('findActiveJobId: done-Job → matcht NICHT (ohne Status-Filter würde Frontend toten Job pollen)', () => {
  const id = shared.createJob('check', 'pageZ', 'u3@x', null);
  shared.jobs.get(id).status = 'done';
  assert.equal(shared.findActiveJobId('check', 'pageZ', 'u3@x'), null);
});

test('findActiveJobId: error/cancelled → matcht NICHT', () => {
  const idErr = shared.createJob('check', 'pageE', 'u4@x', null);
  shared.jobs.get(idErr).status = 'error';
  assert.equal(shared.findActiveJobId('check', 'pageE', 'u4@x'), null);

  const idCan = shared.createJob('check', 'pageC', 'u5@x', null);
  shared.jobs.get(idCan).status = 'cancelled';
  assert.equal(shared.findActiveJobId('check', 'pageC', 'u5@x'), null);
});

test('findActiveJobId: scope userEmail – fremder User sieht Job nicht', () => {
  const id = shared.createJob('review', 'b9', 'alice@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('review', 'b9', 'alice@x'), id);
  assert.equal(shared.findActiveJobId('review', 'b9', 'bob@x'), null);
});

test('findActiveJobId: scope type – anderer Job-Typ matcht nicht', () => {
  const id = shared.createJob('review', 'b10', 'u@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('check', 'b10', 'u@x'), null);
});

test('findActiveJobId: kein Job → null (kein Crash)', () => {
  assert.equal(shared.findActiveJobId('does-not-exist', 'no-id', 'no@one'), null);
});

// ── createJob: Per-Job-Modell-Override landet in job_runs.model ──────────────
// Damit das Kosten-Tracking einen Opus-Lauf nicht zum Sonnet-Tarif verbucht,
// muss job_runs.model das TATSAECHLICH genutzte Modell spiegeln (komplett +
// book-chat fahren eigene Claude-Modelle), nicht das globale.
test('createJob: Modell-Recording (global vs. komplett vs. book-chat)', () => {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.provider', 'claude');
  appSettings.set('ai.claude.model', 'claude-sonnet-4-6');
  appSettings.set('ai.claude.model.komplett', 'claude-opus-4-8');
  appSettings.set('ai.claude.model.bookchat', 'claude-opus-4-8');
  const modelOf = (jobId) => shared.jobs.get(jobId).model;
  const persistedModelOf = (jobId) =>
    db.prepare('SELECT model FROM job_runs WHERE job_id = ?').get(jobId)?.model;

  // Lektorat folgt dem globalen Modell (Sonnet).
  const checkId = shared.createJob('check', 'mb1', 'u@x', null);
  assert.equal(modelOf(checkId), 'claude-sonnet-4-6');
  assert.equal(persistedModelOf(checkId), 'claude-sonnet-4-6');

  // Komplettanalyse + Kontinuität fahren den Komplett-Override (Opus).
  const komplettId = shared.createJob('komplett-analyse', 'mb2', 'u@x', null);
  assert.equal(modelOf(komplettId), 'claude-opus-4-8');
  assert.equal(persistedModelOf(komplettId), 'claude-opus-4-8');
  const kontId = shared.createJob('kontinuitaet', 'mb3', 'u@x', null);
  assert.equal(modelOf(kontId), 'claude-opus-4-8');

  // Mit Lektorat-Override fahren Seiten- und Batch-Lektorat dieses Modell.
  appSettings.set('ai.claude.model.lektorat', 'claude-opus-5-5');
  const checkOvId = shared.createJob('check', 'mb1b', 'u@x', null);
  assert.equal(persistedModelOf(checkOvId), 'claude-opus-5-5');
  assert.equal(modelOf(shared.createJob('batch-check', 'mb1c', 'u@x', null)), 'claude-opus-5-5');
  appSettings.set('ai.claude.model.lektorat', '');

  // Buch-Chat fährt den Bookchat-Override (Opus).
  const bookChatId = shared.createJob('book-chat', 'mb4', 'u@x', null);
  assert.equal(modelOf(bookChatId), 'claude-opus-4-8');
  assert.equal(persistedModelOf(bookChatId), 'claude-opus-4-8');

  // Leerer Override → Fallback auf globales Modell.
  appSettings.set('ai.claude.model.komplett', '');
  const komplettNoOverride = shared.createJob('komplett-analyse', 'mb5', 'u@x', null);
  assert.equal(modelOf(komplettNoOverride), 'claude-sonnet-4-6');
});

// ── createJob: Embedding-Typen tragen provider 'embed', nicht den Chat-Provider
// Die drei Embedding-Jobs fahren /v1/embeddings, keinen Chat-Call. Ohne den
// EMBED_JOB_TYPES-Zweig wies Job-Statistik/Admin-Nutzung/metrics für jeden Lauf
// das globale Chat-Modell aus (Bug: „claude" bei bge-m3).
test('createJob: Embedding-Typen buchen provider=embed + embed.model', () => {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.provider', 'claude');
  appSettings.set('ai.claude.model', 'claude-opus-5-5');
  appSettings.set('embed.model', 'bge-m3');
  const rowOf = (jobId) => db.prepare('SELECT provider, model FROM job_runs WHERE job_id = ?').get(jobId);

  for (const type of ['embed-index', 'source-embed-index', 'chat-embed-index']) {
    const id = shared.createJob(type, 'me1', null, null);
    assert.equal(shared.jobs.get(id).provider, 'embed', `${type}: provider im Job-Record`);
    assert.equal(shared.jobs.get(id).model, 'bge-m3', `${type}: Modell im Job-Record`);
    assert.deepEqual(rowOf(id), { provider: 'embed', model: 'bge-m3' }, `${type}: job_runs-Zeile`);
  }

  // Ein anderes Embedding-Modell schlägt durch — es bleibt beim Chat-Override-Schutz
  // (der darf einem Embedding-Lauf nichts vorschreiben).
  appSettings.set('embed.model', 'nomic-embed-text');
  appSettings.set('ai.claude.model.komplett', 'claude-opus-4-8');
  const id2 = shared.createJob('embed-index', 'me2', null, null);
  assert.deepEqual(rowOf(id2), { provider: 'embed', model: 'nomic-embed-text' });
  appSettings.set('embed.model', 'bge-m3');
  appSettings.set('ai.claude.model.komplett', '');
});

test('setJobModel: Lauf-Start zieht das tatsächlich benutzte Modell nach', () => {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('embed.model', 'bge-m3');
  const id = shared.createJob('embed-index', 'me3', null, null);
  // Admin dreht embed.model zwischen Einreihen und Start um — der Record muss
  // das Modell führen, mit dem der Lauf wirklich eingebettet hat.
  shared.setJobModel(id, shared.EMBED_PROVIDER, 'qwen3-embedding');
  assert.equal(shared.jobs.get(id).model, 'qwen3-embedding');
  assert.equal(db.prepare('SELECT model FROM job_runs WHERE job_id = ?').get(id).model, 'qwen3-embedding');
});

test('retryOnTransientAi: Erfolg im ersten Versuch ruft fn nur einmal', async () => {
  let calls = 0;
  const out = await shared.retryOnTransientAi(async () => { calls++; return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('retryOnTransientAi: retried bei Claude-Timeout (code=AI_TIMEOUT)', async () => {
  let calls = 0;
  const out = await shared.retryOnTransientAi(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('Claude-Timeout nach 600000ms');
      e.code = 'AI_TIMEOUT';
      throw e;
    }
    return 'recovered';
  });
  assert.equal(out, 'recovered');
  assert.equal(calls, 2);
});

test('retryOnTransientAi: retried bei terminated-Fehler (Undici-Socket-Reset)', async () => {
  let calls = 0;
  const out = await shared.retryOnTransientAi(async () => {
    calls++;
    if (calls === 1) throw new TypeError('terminated');
    return 'recovered';
  });
  assert.equal(out, 'recovered');
  assert.equal(calls, 2);
});

test('retryOnTransientAi: deterministischer Fehler wird sofort weitergeworfen', async () => {
  let calls = 0;
  await assert.rejects(
    shared.retryOnTransientAi(async () => { calls++; throw new Error('job.error.aiInvalidJson'); }),
    /aiInvalidJson/,
  );
  assert.equal(calls, 1);
});

test('retryOnTransientAi: AbortError reicht durch ohne Retry', async () => {
  let calls = 0;
  await assert.rejects(
    shared.retryOnTransientAi(async () => {
      calls++;
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test('retryOnTransientAi: nach tries-Verschoepfung wird letzter Fehler geworfen', async () => {
  let calls = 0;
  await assert.rejects(
    shared.retryOnTransientAi(async () => {
      calls++;
      const e = new Error('Claude-Timeout nach 600000ms');
      e.code = 'AI_TIMEOUT';
      throw e;
    }, { tries: 2 }),
    /Claude-Timeout/,
  );
  assert.equal(calls, 2);
});

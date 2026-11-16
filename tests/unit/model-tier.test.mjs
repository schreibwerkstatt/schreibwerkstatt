// Modellstufen der Claude-Jobs (routes/jobs/shared/model-tier.js, Katalog lib/ai/job-tiers.js).
//
// Jeder Claude-Job läuft auf einer von vier Stufen; welche, stellt der Admin pro Job ein
// (`ai.claude.tier.job.<typ>`). «stark» = `ai.claude.model` mit globalen Limits (kein
// Bag). Die übrigen Stufen binden Modell, Fenster, Output-Cap und Timeout als Job-Bag —
// beim Job-Start in der Queue, gemischt in Einstellungen, die der Job schon gesetzt hat.
// Ein fremder Provider bekommt nie ein Stufen-Modell. Vorbelegt stark: Lektorat,
// Komplettanalyse, Urteils- und Kreativ-Jobs; «maximal» mit keinem Job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'model-tier-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  const appSettings = require_('../../lib/app-settings');
  appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
  return {
    appSettings,
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    tier: require_('../../routes/jobs/shared/model-tier'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const quiet = { info() {}, warn() {}, error() {} };

test('Vorbelegung: standard = Sonnet 5.5, leicht = Haiku 5.5, sonst stark; «maximal» nirgends', () => {
  const { tier, teardown } = _bootstrap();
  try {
    const { JOB_TIER_CATALOG } = require_('../../lib/ai/job-tiers');
    assert.equal(JOB_TIER_CATALOG.filter(j => j.tier === 'max').length, 0);
    assert.equal(tier.tierModel('rueckblick', 'claude'), 'claude-sonnet-5-5');
    assert.equal(tier.tierModel('geocode-resolve', 'claude'), 'claude-haiku-5-5');
    assert.equal(tier.tierModel('finetune-export', 'claude'), 'claude-haiku-5-5');
    assert.equal(tier.tierModel('review', 'claude'), 'claude-opus-5-5');
    assert.equal(tier.tierModel('unbekannter-job', 'claude'), 'claude-opus-5-5');
    for (const t of ['book-chat',
      'research-crosscheck', 'source-detect', 'struktur-check', 'book-map-label']) {
      assert.equal(tier.jobTier(t), 'standard', t);
    }
    for (const t of ['figuren-naehe', 'source-pdf-draft', 'folder-import', 'chat-title', 'synonym']) {
      assert.equal(tier.jobTier(t), 'light', t);
    }
    for (const t of ['chat', 'ideen-chat', 'plot-chat', 'research-chat', 'check', 'batch-check', 'komplett-analyse', 'komplett-extract', 'kontinuitaet',
      'kontinuitaet-recheck', 'erzaehlprofil', 'faktencheck', 'review', 'chapter-review', 'expose',
      'stilprofil', 'autorenprofil', 'headline-variants', 'werkstatt-brainstorm', 'werkstatt-consistency',
      'plot-brainstorm', 'plot-consistency', 'motif-brainstorm', 'motif-consistency']) {
      assert.equal(tier.jobTier(t), 'strong', t);
    }
  } finally { teardown(); }
});

test('Zuordnung pro Job einstellbar; leere Stufe läuft wie «stark»', () => {
  const { tier, appSettings, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model.tier.max', 'claude-fable-5-1', { updatedBy: 'test' });
    appSettings.set('ai.claude.tier.job.komplett-analyse', 'max', { updatedBy: 'test' });
    appSettings.set('ai.claude.tier.job.rueckblick', 'light', { updatedBy: 'test' });
    assert.equal(tier.tierModel('komplett-analyse', 'claude'), 'claude-fable-5-1');
    assert.equal(tier.tierModel('rueckblick', 'claude'), 'claude-haiku-5-5');
    appSettings.set('ai.claude.model.tier.max', '', { updatedBy: 'test' });
    assert.equal(tier.tierModel('komplett-analyse', 'claude'), 'claude-opus-5-5');
    assert.throws(() => appSettings.set('ai.claude.tier.job.rueckblick', 'mittel', { updatedBy: 'test' }));
  } finally { teardown(); }
});

test('tierSpec: Fenster/Output aus dem Stufen-Modell, Output aufs Modell-Limit geklemmt', () => {
  const { tier, appSettings, teardown } = _bootstrap();
  try {
    // Globale Limits gehören zu «stark» und dürfen eine andere Stufe nicht treffen.
    appSettings.set('ai.claude.context_window', 1000000, { updatedBy: 'test' });
    assert.deepEqual(tier.tierSpec('light'),
      { model: 'claude-haiku-5-5', contextWindow: 1000000, maxTokensOut: 64000 });
    appSettings.set('ai.claude.model.tier.light', 'claude-haiku-4-5', { updatedBy: 'test' });
    appSettings.set('ai.claude.max_tokens_out.tier.light', 100000, { updatedBy: 'test' });
    appSettings.set('ai.claude.timeout_ms.tier.light', 120000, { updatedBy: 'test' });
    assert.deepEqual(tier.tierSpec('light'),
      { model: 'claude-haiku-4-5', contextWindow: 200000, maxTokensOut: 64000, timeoutMs: 120000 });
    appSettings.set('ai.claude.context_window.tier.light', 150000, { updatedBy: 'test' });
    assert.equal(tier.tierSpec('light').contextWindow, 150000);
    assert.equal(tier.tierSpec('strong'), null);
  } finally { teardown(); }
});

test('bindJobTier: Bag nur im Job-Kontext, nie für fremde Provider; Fenster folgt dem Stufen-Modell', () => {
  const { tier, cfg, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'rueckblick' }, () => {
      assert.equal(tier.bindJobTier('rueckblick', 'claude'), true);
      assert.equal(logCtx.getContext().aiJob.model, 'claude-sonnet-5-5');
      assert.equal(cfg._resolveClaudeModel(), 'claude-sonnet-5-5');
      assert.equal(cfg.getContextConfigFor('claude').maxTokensOut, 128000);
    });
    assert.equal(cfg._resolveClaudeModel(), 'claude-opus-5-5');
    logCtx.runWithContext({ job: 'review' }, () => {
      assert.equal(tier.bindJobTier('review', 'claude'), false);
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
    logCtx.runWithContext({ job: 'rueckblick' }, () => {
      assert.equal(tier.bindJobTier('rueckblick', 'openai-compat'), false);
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('bindJobTier mischt: gesetzte Job-Werte gewinnen, Effort bleibt; fremder Bag wird nicht angefasst', () => {
  const { tier, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'book-chat' }, () => {
      logCtx.setContext({ aiJob: { provider: 'claude', timeoutMs: 2400000, effort: 'medium' } });
      tier.bindJobTier('book-chat', 'claude');
      const bag = logCtx.getContext().aiJob;
      assert.equal(bag.model, 'claude-sonnet-5-5');
      assert.equal(bag.timeoutMs, 2400000);
      assert.equal(bag.effort, 'medium');
    });
    logCtx.runWithContext({ job: 'chat' }, () => {
      logCtx.setContext({ aiJob: { provider: 'openai-compat', contextWindow: 100000 } });
      tier.bindJobTier('chat', 'openai-compat');
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'openai-compat', contextWindow: 100000 });
    });
  } finally { teardown(); }
});

test('applyTierAiOverrides: Stufe + extra, Rückgabe = laufendes Modell (für die cacheVersion)', () => {
  const { tier, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'figur-alter' }, () => {
      assert.equal(tier.applyTierAiOverrides(null, 'figur-alter', 'claude', quiet, { extra: { effort: 'low' } }), 'claude-sonnet-5-5');
      assert.equal(logCtx.getContext().aiJob.effort, 'low');
    });
    logCtx.runWithContext({ job: 'review' }, () => {
      assert.equal(tier.applyTierAiOverrides(null, 'review', 'claude', quiet), 'claude-opus-5-5');
    });
  } finally { teardown(); }
});

test('Queue bindet die Stufe beim Job-Start für jeden Claude-Job', async () => {
  const { appSettings, cfg, teardown } = _bootstrap();
  try {
    appSettings.set('ai.provider', 'claude', { updatedBy: 'test' });
    appSettings.set('ai.claude.tier.job.review', 'light', { updatedBy: 'test' });
    const shared = require_('../../routes/jobs/shared');
    const seen = await new Promise((resolve) => {
      const id = shared.createJob('review', 'qb1', 'u@x', null);
      assert.equal(shared.jobs.get(id).model, 'claude-haiku-5-5');
      shared.enqueueJob(id, async () => {
        resolve({ model: cfg._resolveClaudeModel(), maxOut: cfg.getContextConfigFor('claude').maxTokensOut });
        shared.completeJob(id, {});
      });
    });
    assert.deepEqual(seen, { model: 'claude-haiku-5-5', maxOut: 64000 });
  } finally { teardown(); }
});

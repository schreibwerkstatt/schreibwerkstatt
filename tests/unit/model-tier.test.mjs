// Modellstufen der Claude-Jobs (routes/jobs/shared/model-tier.js).
//
// JOB_TIERS ordnet Job-Typen «standard»/«leicht» zu, alles andere läuft stark auf
// `ai.claude.model`. Eine Per-Job-Einstellung schlägt die Stufe, ein fremder Provider
// und ein eigener KI-Zugang bekommen nie ein Stufen-Modell. Lektorat, Chats und die
// Komplettanalyse sind bewusst ungestuft — das hält der letzte Test fest.

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

test('Stufen-Defaults: standard = Sonnet 5.5, leicht = Haiku 5.5, sonst stark', () => {
  const { tier, teardown } = _bootstrap();
  try {
    assert.equal(tier.tierModel('rueckblick', 'claude'), 'claude-sonnet-5-5');
    assert.equal(tier.tierModel('figur-alter', 'claude'), 'claude-sonnet-5-5');
    assert.equal(tier.tierModel('geocode-resolve', 'claude'), 'claude-haiku-5-5');
    assert.equal(tier.tierModel('finetune-export', 'claude', { jobKey: 'finetune' }), 'claude-haiku-5-5');
    assert.equal(tier.tierModel('review', 'claude'), 'claude-opus-5-5');
  } finally { teardown(); }
});

test('Per-Job-Einstellung schlägt die Stufe, leere Stufe folgt dem globalen Modell', () => {
  const { tier, appSettings, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model.finetune', 'claude-sonnet-5-5', { updatedBy: 'test' });
    assert.equal(tier.tierModel('finetune-export', 'claude', { jobKey: 'finetune' }), 'claude-sonnet-5-5');
    appSettings.set('ai.claude.model.tier.standard', '', { updatedBy: 'test' });
    assert.equal(tier.tierModel('rueckblick', 'claude'), 'claude-opus-5-5');
  } finally { teardown(); }
});

test('applyTierAiOverrides bindet das Modell nur im Job-Kontext, nie für fremde Provider', () => {
  const { tier, cfg, logCtx, teardown } = _bootstrap();
  try {
    logCtx.runWithContext({ job: 'rueckblick' }, () => {
      assert.equal(tier.applyTierAiOverrides(null, 'rueckblick', 'claude', quiet), 'claude-sonnet-5-5');
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', model: 'claude-sonnet-5-5' });
      assert.equal(cfg._resolveClaudeModel(), 'claude-sonnet-5-5');
    });
    assert.equal(cfg._resolveClaudeModel(), 'claude-opus-5-5');
    logCtx.runWithContext({ job: 'review' }, () => {
      tier.applyTierAiOverrides(null, 'review', 'claude', quiet);
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
    logCtx.runWithContext({ job: 'rueckblick' }, () => {
      tier.applyTierAiOverrides(null, 'rueckblick', 'openai-compat', quiet);
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('Lektorat, Chats und Komplettanalyse bleiben ungestuft', () => {
  const { tier, teardown } = _bootstrap();
  try {
    for (const t of ['check', 'lektorat', 'chat', 'book-chat', 'research-chat', 'plot-chat', 'ideen-chat',
      'komplett-analyse', 'kontinuitaet', 'erzaehlprofil', 'review', 'chapter-review']) {
      assert.equal(tier.jobTier(t), 'strong', t);
    }
  } finally { teardown(); }
});

// Synonym-Modell + -Effort.
//
// Die KI-Synonymsuche ist ein interaktiver Kurz-Call im Kontextmenue. Auf einem
// denkenden globalen Modell (Opus 5.5) wartet der User sonst ~8 s auf eine Wortliste.
// `applySynonymAiOverrides` routet `ai.claude.model.synonym` (z.B. Sonnet 5.5) und
// bindet `ai.claude.effort.synonym` (Default 'low') — Effort nur, wenn das so gewaehlte
// Modell adaptiv denkt. Modell und Effort gehen in die cacheVersion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'synonym-model-'));
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
    syn: require_('../../routes/jobs/synonyme'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test('applySynonymAiOverrides: ohne Synonym-Modell folgt es dem globalen, Effort low', () => {
  const { syn, cfg, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'synonym' }, () => {
      assert.deepEqual(syn.applySynonymAiOverrides('claude', quietLogger), { model: 'claude-opus-5-5', cacheSuffix: ':e=low' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', effort: 'low' });
      assert.deepEqual(cfg._claudeOutputConfigParams('claude-opus-5-5'), { output_config: { effort: 'low' } });
    });
  } finally { teardown(); }
});

test('applySynonymAiOverrides: ai.claude.model.synonym routet das Modell nur im Job-Kontext', () => {
  const { syn, cfg, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    appSettings.set('ai.claude.model.synonym', 'claude-sonnet-5-5', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'synonym' }, () => {
      assert.deepEqual(syn.applySynonymAiOverrides('claude', quietLogger), { model: 'claude-sonnet-5-5', cacheSuffix: ':e=low' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' });
      assert.equal(cfg._resolveClaudeModel(), 'claude-sonnet-5-5');
    });
    assert.equal(cfg._resolveClaudeModel(), 'claude-opus-5-5');
  } finally { teardown(); }
});

test('applySynonymAiOverrides: Modell ohne Denken setzt keinen Effort, fremder Provider keinen Bag', () => {
  const { syn, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    appSettings.set('ai.claude.model.synonym', 'claude-sonnet-4-6', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'synonym' }, () => {
      assert.deepEqual(syn.applySynonymAiOverrides('claude', quietLogger), { model: 'claude-sonnet-4-6', cacheSuffix: '' });
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', model: 'claude-sonnet-4-6' });
    });
    logCtx.runWithContext({ job: 'synonym' }, () => {
      assert.equal(syn.applySynonymAiOverrides('openai-compat', quietLogger).cacheSuffix, '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

// Haiku 5+ lehnt Sampling-Parameter ab und denkt adaptiv — als Synonym-Modell
// bekaeme es sonst temperature 0.3 und jeder Call stuerbe mit HTTP 400.
test('Haiku 5.5 gilt als moderne Generation: kein temperature, adaptives Denken, Effort', () => {
  const { cfg, teardown } = _bootstrap();
  try {
    assert.equal(cfg._claudeAcceptsTemperature('claude-haiku-5-5'), false);
    assert.equal(cfg._claudeUsesAdaptiveThinking('claude-haiku-5-5'), true);
    assert.equal(cfg._claudeAcceptsTemperature('claude-haiku-4-5'), true);
  } finally { teardown(); }
});

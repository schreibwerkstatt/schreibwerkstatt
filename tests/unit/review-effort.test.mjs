// Effort der Buch- und Kapitelbewertung.
//
// Ohne Effort-Feld gilt der Modell-Default, und der wechselt mit dem Modell (Opus 5.5:
// 'medium', davor 'high'). `applyReviewAiOverrides` bindet deshalb
// `ai.claude.effort.review` (Default 'high') — nur auf Claude-Modellen mit adaptivem
// Denken; der Effort fliesst in die cacheVersion der Review-Caches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'review-effort-'));
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
    model: require_('../../routes/jobs/shared/model'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

test('applyReviewAiOverrides: Opus 5.5 bekommt den Default-Effort high im Job-Bag', () => {
  const { model, cfg, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'review' }, () => {
      assert.equal(model.applyReviewAiOverrides('claude', quietLogger), ':e=high');
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', effort: 'high' });
      assert.deepEqual(cfg._claudeOutputConfigParams('claude-opus-5-5'), { output_config: { effort: 'high' } });
    });
  } finally { teardown(); }
});

test('applyReviewAiOverrides: Sonnet 4.6, fremde Provider und leerer Wert bleiben ohne Bag', () => {
  const { model, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-sonnet-4-6', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'review' }, () => {
      assert.equal(model.applyReviewAiOverrides('claude', quietLogger), '');
      assert.equal(model.applyReviewAiOverrides('openai-compat', quietLogger), '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    appSettings.set('ai.claude.effort.review', '', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'review' }, () => {
      assert.equal(model.applyReviewAiOverrides('claude', quietLogger), '');
      assert.equal(logCtx.getContext().aiJob, undefined);
    });
  } finally { teardown(); }
});

test('applyEffortSetting: Plot-Werkstatt bindet ai.claude.effort.plot (Default medium)', () => {
  const { model, appSettings, logCtx, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'plot-consistency' }, () => {
      assert.equal(model.applyEffortSetting('ai.claude.effort.plot', 'claude', quietLogger, 'Plot'), ':e=medium');
      assert.deepEqual(logCtx.getContext().aiJob, { provider: 'claude', effort: 'medium' });
    });
    appSettings.set('ai.claude.effort.plot', 'low', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'plot-consistency' }, () => {
      assert.equal(model.applyEffortSetting('ai.claude.effort.plot', 'claude', quietLogger, 'Plot'), ':e=low');
    });
  } finally { teardown(); }
});

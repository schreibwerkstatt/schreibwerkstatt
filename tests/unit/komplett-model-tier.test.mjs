// Komplettanalyse auf Modellstufen (routes/jobs/komplett/job-shared.js#_komplettAiOverrides,
// extract-plan.js#buildExtractTier).
//
// Claude: Modell/Fenster/Output kommen aus der Stufe des Jobs, Effort und
// `ai.claude.timeout_ms.komplett` aus den Komplett-Keys. Läuft die Analyse auf eigener
// Stufe ohne eigenen Timeout, greifen mindestens 30 Min. Die Extraktion bekommt nur dann
// ein Per-Call-Modell, wenn ihre Stufe ein anderes Modell liefert als der Job — sonst
// bliebe die Phase-1-cacheVersion nicht dieselbe wie ohne Stufen (teurer Volllauf).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'komplett-tier-'));
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
    logCtx: require_('../../lib/log-context'),
    shared: require_('../../routes/jobs/komplett/job-shared'),
    plan: require_('../../routes/jobs/komplett/extract-plan'),
    sig: require_('../../routes/jobs/komplett/signatures'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('Stufe «stark» (Default): Bag nur mit Effort + Komplett-Timeout, wie ohne Stufen', () => {
  const { appSettings, logCtx, shared, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.effort.komplett', 'medium', { updatedBy: 'test' });
    appSettings.set('ai.claude.timeout_ms.komplett', 2400000, { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'komplett-analyse' }, () => {
      assert.deepEqual(shared._komplettAiOverrides('claude'),
        { aiJob: { provider: 'claude', effort: 'medium', timeoutMs: 2400000 } });
    });
  } finally { teardown(); }
});

test('Eigene Stufe: Modell + Fenster aus der Stufe, Timeout mindestens 30 Min', () => {
  const { appSettings, logCtx, shared, teardown } = _bootstrap();
  try {
    appSettings.set('ai.claude.model.tier.max', 'claude-fable-5-1', { updatedBy: 'test' });
    appSettings.set('ai.claude.tier.job.komplett-analyse', 'max', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'komplett-analyse' }, () => {
      const { aiJob } = shared._komplettAiOverrides('claude');
      assert.equal(aiJob.model, 'claude-fable-5-1');
      assert.equal(aiJob.contextWindow, 1000000);
      assert.equal(aiJob.timeoutMs, 1800000);
    });
    // Andere Jobs der Familie behalten ihre eigene Stufe.
    logCtx.runWithContext({ job: 'kontinuitaet' }, () => {
      assert.equal(shared._komplettAiOverrides('claude'), null);
    });
  } finally { teardown(); }
});

test('Extraktion: Per-Call-Modell nur bei abweichender Stufe; cacheVersion sonst unverändert', () => {
  const { appSettings, logCtx, shared, plan, sig, teardown } = _bootstrap();
  try {
    const base = (tier) => sig.extractCacheBase({ provider: 'claude', tier, sys: null, extractVersion: 'v' });
    let before;
    logCtx.runWithContext({ job: 'komplett-analyse' }, () => {
      const tier = plan.buildExtractTier('claude');
      assert.equal(tier.model, undefined);
      before = base(tier);
      assert.ok(before.startsWith('claude-opus-5-5:'));
    });
    appSettings.set('ai.claude.tier.job.komplett-extract', 'standard', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'komplett-analyse' }, () => {
      const tier = plan.buildExtractTier('claude');
      assert.equal(tier.model, 'claude-sonnet-5-5');
      assert.ok(base(tier).startsWith('claude-sonnet-5-5:'));
    });
    // Job und Extraktion beide auf «standard»: gleiches Modell, kein Per-Call-Modell.
    appSettings.set('ai.claude.tier.job.komplett-analyse', 'standard', { updatedBy: 'test' });
    logCtx.runWithContext({ job: 'komplett-analyse' }, () => {
      shared._komplettAiOverrides('claude');
      assert.equal(plan.buildExtractTier('claude').model, undefined);
    });
  } finally { teardown(); }
});

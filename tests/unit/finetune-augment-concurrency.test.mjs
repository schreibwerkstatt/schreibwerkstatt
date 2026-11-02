// Unit: Pool-Grösse der KI-Phasen im Finetune-Export — nur Haiku bekommt den
// grossen Pool, jedes andere (oder unbekannte) Modell bleibt beim kleinen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  augmentConcurrency, AUGMENT_CONCURRENCY, AUGMENT_CONCURRENCY_HAIKU,
} = require('../../routes/jobs/finetune-export/lib/augment-util');

test('Haiku läuft mit dem grossen Pool', () => {
  assert.ok(AUGMENT_CONCURRENCY_HAIKU > AUGMENT_CONCURRENCY);
  assert.equal(augmentConcurrency('claude-haiku-5-5'), AUGMENT_CONCURRENCY_HAIKU);
  assert.equal(augmentConcurrency('claude-haiku-4-5-20251001'), AUGMENT_CONCURRENCY_HAIKU);
});

test('andere Modelle und fehlendes Modell bleiben beim kleinen Pool', () => {
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5', 'qwen3', '', undefined, null]) {
    assert.equal(augmentConcurrency(m), AUGMENT_CONCURRENCY, String(m));
  }
});

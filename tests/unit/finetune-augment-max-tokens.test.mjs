// Output-Deckel der Finetune-Augment-Calls (routes/jobs/finetune-export/lib/augment-util.js):
// Reserve fürs adaptive Denken, wächst mit der erwarteten Antwortlänge, gedeckelt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { augmentMaxTokens } = require('../../routes/jobs/finetune-export/lib/augment-util.js');

test('augmentMaxTokens: Denk-Reserve, wächst mit der Länge, oben gedeckelt', () => {
  // Kurze Antworten bekommen deutlich mehr als die früheren festen 1500.
  assert.ok(augmentMaxTokens(600) >= 3000);
  // Langer Entwicklungsbogen (~6000 Zeichen, 1,5-fach erwartet) passt samt Reserve.
  assert.ok(augmentMaxTokens(9000) > 3000 + 9000 / 3.3);
  assert.ok(augmentMaxTokens(9000) > augmentMaxTokens(600));
  assert.equal(augmentMaxTokens(1e7), 16000);
  assert.equal(augmentMaxTokens(undefined), 3000);
});

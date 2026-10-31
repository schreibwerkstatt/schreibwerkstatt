'use strict';
// routes/jobs/shared/bundles.js#bundleBlocks: Bündel mit Eingabe- UND Antwort-Deckel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bundleBlocks } = require('../../routes/jobs/shared/bundles');

const sizes = (bundles) => bundles.map(b => b.length);

test('ohne outBudget zählt nur die Eingabe', () => {
  const blocks = Array.from({ length: 10 }, () => ({ chars: 100, outEst: 500 }));
  assert.deepEqual(sizes(bundleBlocks(blocks, { charBudget: 1000 })), [10]);
  assert.deepEqual(sizes(bundleBlocks(blocks, { charBudget: 300 })), [3, 3, 3, 1]);
});

test('Antwort-Schätzung teilt ein Bündel, das in die Eingabe passt', () => {
  const blocks = Array.from({ length: 80 }, () => ({ chars: 100, outEst: 240 }));
  const bundles = bundleBlocks(blocks, { charBudget: 1e9, outBudget: 4800 });
  assert.deepEqual(sizes(bundles), [20, 20, 20, 20]);
});

test('ein Block über einem Deckel bildet sein eigenes Bündel, nie ein leeres', () => {
  const blocks = [{ chars: 10, outEst: 10 }, { chars: 10, outEst: 9999 }, { chars: 10, outEst: 10 }];
  assert.deepEqual(sizes(bundleBlocks(blocks, { charBudget: 1e9, outBudget: 100 })), [1, 1, 1]);
  assert.deepEqual(bundleBlocks([], { charBudget: 100, outBudget: 100 }), []);
});

test('Reihenfolge der Blöcke bleibt erhalten', () => {
  const blocks = Array.from({ length: 7 }, (_, i) => ({ id: i, chars: 1, outEst: 3 }));
  const flat = bundleBlocks(blocks, { charBudget: 100, outBudget: 7 }).flat().map(b => b.id);
  assert.deepEqual(flat, [0, 1, 2, 3, 4, 5, 6]);
});

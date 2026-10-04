// komplettMaxTokens gehört in den maxTokens-Slot von aiCall/call
// (… fromPct, toPct, expectedChars, outputRatio, maxTokens, …), nicht in
// expectedChars: dort reserviert der Call sonst das Provider-Ceiling, und der
// VRAM-Deckel ai.komplett.extract_max_tokens greift bei lokalen Providern nicht.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../routes/jobs');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('komplettMaxTokens steht nie im expectedChars-Slot (vor outputRatio)', () => {
  const bad = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    // Muster: komplettMaxTokens(...) direkt gefolgt von outputRatio (0.x) —
    // dann ist es das expectedChars-Argument.
    const re = /komplettMaxTokens\([^)]*\)\s*,\s*0\.\d+\s*,/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(bad, []);
});

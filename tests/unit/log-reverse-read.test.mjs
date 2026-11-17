// log-reverse-read: rueckwaerts Zeilen, mehrere Files (Rotation).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { makeTmpDir } from './_helpers/tmp-dir.js';

const require = createRequire(import.meta.url);
const { readLinesReverse, listRotatedFiles } = require('../../lib/log-reverse-read');

async function collect(filePath) {
  const out = [];
  for await (const line of readLinesReverse(filePath)) out.push(line);
  return out;
}

test('reads small file reverse, line by line', async () => {
  const f = path.join(os.tmpdir(), `lrr-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(f, 'a\nb\nc\n');
  try {
    const lines = await collect(f);
    assert.deepEqual(lines, ['c', 'b', 'a']);
  } finally { fs.unlinkSync(f); }
});

test('reads large multi-chunk file reverse', async () => {
  const f = path.join(os.tmpdir(), `lrr2-${process.pid}-${Date.now()}.log`);
  const data = [];
  for (let i = 0; i < 5000; i++) data.push(`line-${i}`);
  fs.writeFileSync(f, data.join('\n') + '\n');
  try {
    const lines = await collect(f);
    assert.equal(lines.length, 5000);
    assert.equal(lines[0], 'line-4999');
    assert.equal(lines[4999], 'line-0');
  } finally { fs.unlinkSync(f); }
});

test('handles file without trailing newline', async () => {
  const f = path.join(os.tmpdir(), `lrr3-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(f, 'a\nb\nc');
  try {
    const lines = await collect(f);
    assert.deepEqual(lines, ['c', 'b', 'a']);
  } finally { fs.unlinkSync(f); }
});

test('missing file yields nothing', async () => {
  const f = path.join(os.tmpdir(), `lrr-missing-${Date.now()}.log`);
  const lines = await collect(f);
  assert.deepEqual(lines, []);
});

test('listRotatedFiles returns base + rotations in order', () => {
  const dir = makeTmpDir('lrr-rot-');
  try {
    const base = path.join(dir, 'app.log');
    fs.writeFileSync(base, 'x');
    fs.writeFileSync(path.join(dir, 'app1.log'), 'y');
    fs.writeFileSync(path.join(dir, 'app2.log'), 'z');
    const list = listRotatedFiles(base, 4);
    assert.deepEqual(list.map(p => path.basename(p)), ['app.log', 'app1.log', 'app2.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

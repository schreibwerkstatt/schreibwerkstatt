// Unit: Auswertung des Single-Pass-Fakten-Calls (C) — Trunkierung wird kapitelgruppen-
// weise gerettet, ein echter Ausfall meldet `failed` (der Job ersetzt den Fakten-Index
// dann NICHT mit []), Abbruch bleibt fatal.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('fakten-pass');
const { resolveSinglePassFakten } = require('../../routes/jobs/komplett/phases/extraktion/fakten-pass.js');

function makeCtx(callImpl) {
  const groups = new Map([
    ['a', { name: 'Kapitel A', pages: [{ text: 'x'.repeat(100) }] }],
    ['b', { name: 'Kapitel B', pages: [{ text: 'y'.repeat(100) }] }],
    ['c', { name: 'Kapitel C', pages: [{ text: 'z'.repeat(100) }] }],
  ]);
  const prompts = {
    buildExtraktionFaktenPassPrompt: (_k, _b, _n, _t, opts) => JSON.stringify(opts?.nurKapitel || []),
    SCHEMA_KOMPLETT_FAKTEN_PASS: {},
  };
  const warnings = [];
  return {
    warnings,
    ctx: {
      jobId: 'j', bookName: 'B', call: callImpl, tok: {}, log: { warn() {}, info() {} },
      prompts, sys: { SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS: [] }, pageContents: [1, 2, 3],
      groups, groupOrder: ['a', 'b', 'c'], extractTier: null, warnings,
    },
  };
}
const truncErr = () => Object.assign(new Error('job.error.aiTruncated'), { name: 'Error' });

test('erfolgreicher Call: Fakten durchgereicht', async () => {
  const { ctx } = makeCtx(async () => { throw new Error('nicht aufrufen'); });
  const r = await resolveSinglePassFakten(ctx, { status: 'fulfilled', value: { fakten: [{ fakt: 'a' }] } }, {});
  assert.deepEqual(r, { fakten: [{ fakt: 'a' }], failed: false });
});

test('Trunkierung: Rettung je Kapitelgruppe, Ergebnisse vereinigt', async () => {
  const seen = [];
  const { ctx, warnings } = makeCtx(async (_j, _t, prompt) => {
    seen.push(JSON.parse(prompt));
    return { fakten: [{ fakt: `aus ${JSON.parse(prompt).join('+')}` }] };
  });
  const r = await resolveSinglePassFakten(ctx, { status: 'rejected', reason: truncErr() }, { bookSystemBlock: {} });
  assert.equal(r.failed, false);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.flat().sort(), ['Kapitel A', 'Kapitel B', 'Kapitel C']);
  assert.equal(r.fakten.length, 3);
  assert.equal(warnings.length, 0);
});

test('Rettung scheitert in einer Gruppe → failed + Warnung, keine Teil-Fakten', async () => {
  let n = 0;
  const { ctx, warnings } = makeCtx(async () => { if (++n === 2) throw new Error('boom'); return { fakten: [{ fakt: 'x' }] }; });
  const r = await resolveSinglePassFakten(ctx, { status: 'rejected', reason: truncErr() }, { bookSystemBlock: {} });
  assert.deepEqual(r, { fakten: [], failed: true });
  assert.deepEqual(warnings, [{ key: 'job.warn.faktenFailed' }]);
});

test('anderer Fehler: keine Rettung, failed', async () => {
  const { ctx } = makeCtx(async () => { throw new Error('nicht aufrufen'); });
  const r = await resolveSinglePassFakten(ctx, { status: 'rejected', reason: new Error('provider down') }, {});
  assert.equal(r.failed, true);
});

test('Abbruch bleibt fatal', async () => {
  const { ctx } = makeCtx(async () => { throw new Error('nicht aufrufen'); });
  const abort = new DOMException('Aborted', 'AbortError');
  await assert.rejects(() => resolveSinglePassFakten(ctx, { status: 'rejected', reason: abort }, {}), (e) => e.name === 'AbortError');
});

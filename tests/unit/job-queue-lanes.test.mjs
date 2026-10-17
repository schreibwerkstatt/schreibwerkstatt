// Job-Queue mit zwei Spuren (routes/jobs/shared/queue.js):
//   • allgemeine Slots (`jobs.max_concurrent`) für alle Typen, FIFO;
//   • reservierte Slots (`jobs.interactive_slots`) nur für interaktive Typen
//     (Chats, Synonyme) — ein Chat-Turn wartet nie hinter einer langen Analyse.
//   • Warteposition zählt innerhalb der eigenen Spur.
//
// Lauf: `node --test tests/unit/job-queue-lanes.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('job-queue-lanes');
delete process.env.ADMIN_EMAIL;
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const { createJob, enqueueJob, jobs, jobQueue } = require('../../routes/jobs/shared');
const { _slotUsage } = require('../../routes/jobs/shared/queue');
const { queuePosition, isInteractiveJobType } = require('../../routes/jobs/shared/state');
const { jobView } = require('../../routes/jobs/shared/serialize');

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Job, der läuft, bis der Test ihn freigibt.
function gated(type) {
  let release;
  const done = new Promise((r) => { release = r; });
  const id = createJob(type, 'b1', null, 'x');
  let started = false;
  enqueueJob(id, async () => { started = true; await done; require('../../routes/jobs/shared').completeJob(id, {}); });
  return { id, release, started: () => started };
}

test('interaktive Typen: die fünf Chats + Synonyme, keine Analyse', () => {
  for (const t of ['chat', 'book-chat', 'research-chat', 'plot-chat', 'ideen-chat', 'synonym']) assert.ok(isInteractiveJobType(t), t);
  for (const t of ['komplett-analyse', 'review', 'check', 'blog-import']) assert.ok(!isInteractiveJobType(t), t);
});

test('Chat überholt wartende Analyse über den reservierten Slot; Analyse-FIFO bleibt', async () => {
  appSettings.set('jobs.max_concurrent', 1, { updatedBy: 'test@x' });
  appSettings.set('jobs.interactive_slots', 1, { updatedBy: 'test@x' });
  const heavy1 = gated('komplett-analyse');
  await waitFor(heavy1.started);
  const heavy2 = gated('review');
  const chat1 = gated('chat');
  const chat2 = gated('book-chat');
  await waitFor(chat1.started);
  assert.equal(heavy2.started(), false, 'zweite Analyse wartet auf den allgemeinen Slot');
  assert.equal(chat2.started(), false, 'zweiter Chat wartet (Reserve belegt, allgemeiner Slot belegt)');
  assert.deepEqual(_slotUsage(), { shared: 1, reserved: 1 });
  // Position je Spur: Analyse 1., Chat 1.
  assert.equal(queuePosition(heavy2.id), 1);
  assert.equal(queuePosition(chat2.id), 1);
  assert.deepEqual(jobView(jobs.get(chat2.id)).statusParams, { pos: 1 });

  // Reserve frei → wartender Chat startet, Analyse wartet weiter.
  chat1.release();
  await waitFor(chat2.started);
  assert.equal(heavy2.started(), false);
  // Allgemeiner Slot frei → Analyse startet.
  heavy1.release();
  await waitFor(heavy2.started);
  chat2.release(); heavy2.release();
  await waitFor(() => jobQueue.length === 0 && _slotUsage().shared === 0 && _slotUsage().reserved === 0);
});

test('interactive_slots = 0: Chat wartet wie früher hinter der Analyse', async () => {
  appSettings.set('jobs.max_concurrent', 1, { updatedBy: 'test@x' });
  appSettings.set('jobs.interactive_slots', 0, { updatedBy: 'test@x' });
  const heavy = gated('komplett-analyse');
  await waitFor(heavy.started);
  const chat = gated('chat');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(chat.started(), false);
  heavy.release();
  await waitFor(chat.started);
  chat.release();
  await waitFor(() => _slotUsage().shared === 0);
});

test('Chat nimmt einen freien allgemeinen Slot, wenn die Reserve belegt ist', async () => {
  appSettings.set('jobs.max_concurrent', 1, { updatedBy: 'test@x' });
  appSettings.set('jobs.interactive_slots', 1, { updatedBy: 'test@x' });
  const c1 = gated('chat');
  const c2 = gated('plot-chat');
  await waitFor(() => c1.started() && c2.started());
  assert.deepEqual(_slotUsage(), { shared: 1, reserved: 1 });
  c1.release(); c2.release();
  await waitFor(() => _slotUsage().shared === 0 && _slotUsage().reserved === 0);
});

test('Default jobs.interactive_slots = 2, jobs.max_concurrent = 1', () => {
  appSettings.remove('jobs.interactive_slots');
  appSettings.remove('jobs.max_concurrent');
  assert.equal(appSettings.get('jobs.interactive_slots'), 2);
  assert.equal(appSettings.get('jobs.max_concurrent'), 1);
});

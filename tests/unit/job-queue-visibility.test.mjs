// Sichtbarkeit in Job-Leiste und Stream (routes/jobs/shared/serialize.js):
//   • eigene Jobs sieht nur ihr User;
//   • Buch-System-Jobs (Embedding-Indizes, userEmail null) sieht jeder mit Zugriff
//     aufs Buch — ohne Abbrechen-Knopf;
//   • andere Jobs ohne User bleiben unsichtbar.
//
// Lauf: `node --test tests/unit/job-queue-visibility.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('job-queue-visibility');
require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const { createJob, jobs } = require('../../routes/jobs/shared');
const { queueItems, hasQueuedJob, isJobVisibleTo } = require('../../routes/jobs/shared/serialize');

appUsers.createUser({ email: 'alice@x.ch', displayName: 'Alice' });
appUsers.createUser({ email: 'eve@x.ch', displayName: 'Eve' });
const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
  .run(2001, 'Buch A', now, now, 'alice@x.ch');
bookAccess.grantAccess(2001, 'alice@x.ch', 'owner', 'test');

test('Embedding-Index: sichtbar mit Buchzugriff, nicht abbrechbar; ohne Zugriff unsichtbar', () => {
  const id = createJob('embed-index', 2001, null, 'job.label.embedIndex', null, 2001);
  const chatId = createJob('chat-embed-index', 2001, null, 'job.label.chatEmbedIndex', null, 2001);
  const mine = queueItems('alice@x.ch');
  for (const jid of [id, chatId]) {
    const item = mine.find(j => j.id === jid);
    assert.ok(item, jid);
    assert.equal(item.canCancel, false);
  }
  assert.ok(hasQueuedJob('alice@x.ch'));
  assert.ok(!queueItems('eve@x.ch').some(j => j.id === id || j.id === chatId));
  assert.ok(!hasQueuedJob('eve@x.ch'));
  assert.ok(!isJobVisibleTo(jobs.get(id), null));
  jobs.delete(id); jobs.delete(chatId);
});

test('eigener Job: nur für seinen User, abbrechbar; anderer System-Job unsichtbar', () => {
  const own = createJob('review', 2001, 'eve@x.ch', 'x');
  const foreign = createJob('komplett-analyse', 2001, null, 'x');
  assert.equal(queueItems('eve@x.ch').find(j => j.id === own)?.canCancel, true);
  assert.ok(!queueItems('alice@x.ch').some(j => j.id === own));
  assert.ok(!queueItems('alice@x.ch').some(j => j.id === foreign));
  jobs.delete(own); jobs.delete(foreign);
});

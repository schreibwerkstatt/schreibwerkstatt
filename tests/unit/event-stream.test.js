'use strict';
// GET /events/stream (routes/events/stream.js):
//  Job-Kanal
//  - Initiales `queue`-Event beim Connect
//  - Job-Änderungen eines Users erreichen nur SEINEN Stream
//  - Progress wird gedrosselt gesammelt, Terminal-Status flusht sofort
//  - `job`-Events tragen kein `result`
//  - 401 ohne Session
//  Buch-Kanal
//  - Abo nur mit Rolle am Buch (`hello.book`)
//  - Anstoss bei fremdem Save und eigenem Zweitgerät, kein Echo des eigenen Geräts
//  - Presence-Anstoss nur bei Zustandswechsel, nicht pro Heartbeat
//  - Zugriff entzogen → `gone` statt Anstoss
//  - Heartbeat hält die eigenen Presence-Rows frisch

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('eventstream');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const express = require('express');
const shared = require('../../routes/jobs/shared');
const contentStore = require('../../lib/content-store');
const bookAccess = require('../../db/book-access');
const bookPresence = require('../../db/book-presence');
const pagePresence = require('../../db/page-presence');
const { db } = require('../../db/connection');
for (const email of ['alice@x', 'bob@x']) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(email);

const DEV_A1 = '11111111-1111-4111-8111-111111111111';
const DEV_A2 = '22222222-2222-4222-8222-222222222222';
const DEV_B = '33333333-3333-4333-8333-333333333333';
const ctx = (email) => ({ session: { user: { email } }, headers: {} });
const appUsersDevices = require('../../db/app-users-devices');
appUsersDevices.upsertDevice(DEV_A1, 'alice@x', 'test');
appUsersDevices.upsertDevice(DEV_A2, 'alice@x', 'test');
appUsersDevices.upsertDevice(DEV_B, 'bob@x', 'test');

let server;
let base;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const email = req.headers['x-test-user'];
    req.session = email ? { user: { email } } : {};
    next();
  });
  app.use('/jobs', shared.sharedRouter);
  app.use('/events', require('../../routes/events'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections?.();
  server.close();
});

// Öffnet einen Stream und sammelt geparste Events.
function connect(user, query = '') {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const req = http.get(`${base}/events/stream${query}`, { headers: user ? { 'x-test-user': user } : {} }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (!ev || !data) continue;
          events.push({ event: ev[1], data: JSON.parse(data[1]), at: Date.now() });
          for (const w of [...waiters]) w();
        }
      });
      resolve({
        status: res.statusCode,
        events,
        close: () => req.destroy(),
        // Wartet, bis `pred(events)` wahr ist (oder Timeout).
        until: (pred, ms = 2000) => new Promise((ok, fail) => {
          if (pred(events)) return ok();
          const t = setTimeout(() => fail(new Error('timeout: ' + JSON.stringify(events.map(e => e.event)))), ms);
          const w = () => { if (pred(events)) { clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); ok(); } };
          waiters.push(w);
        }),
      });
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('ohne Session: 401', async () => {
  const s = await connect(null);
  assert.equal(s.status, 401);
  s.close();
});

test('Connect liefert initiales queue-Event', async () => {
  const s = await connect('alice@x');
  await s.until(ev => ev.some(e => e.event === 'queue'));
  const q = s.events.find(e => e.event === 'queue');
  assert.ok(Array.isArray(q.data));
  s.close();
});

test('Job-Lifecycle: nur eigener Stream, Progress gedrosselt, Terminal sofort, ohne result', async () => {
  const a = await connect('alice@x');
  const b = await connect('bob@x');
  await a.until(ev => ev.some(e => e.event === 'queue'));
  await b.until(ev => ev.some(e => e.event === 'queue'));

  let release;
  const gate = new Promise(r => { release = r; });
  const jobId = shared.createJob('test-stream', 'b1', 'alice@x', 'job.label.check');
  shared.enqueueJob(jobId, async () => {
    await gate;
    shared.completeJob(jobId, { big: 'x'.repeat(1000) });
  });

  // Viele schnelle Updates → wenige gebündelte job-Events.
  for (let i = 1; i <= 20; i++) shared.updateJob(jobId, { progress: i * 4, statusText: 'job.phase.aiReply' });
  await a.until(ev => ev.some(e => e.event === 'job' && e.data.progress === 80));
  const progressEvents = a.events.filter(e => e.event === 'job' && e.data.status === 'running');
  assert.ok(progressEvents.length <= 3, `gedrosselt erwartet, bekam ${progressEvents.length}`);
  assert.ok(!('result' in progressEvents.at(-1).data), 'job-Event ohne result');
  assert.equal(a.events.filter(e => e.event === 'queue').at(-1).data[0].id, jobId);

  // Terminal: sofort (deutlich unter FLUSH_MS), Queue danach leer.
  const t0 = Date.now();
  release();
  await a.until(ev => ev.some(e => e.event === 'job' && e.data.status === 'done'));
  const doneEv = a.events.find(e => e.event === 'job' && e.data.status === 'done');
  const { FLUSH_MS } = require('../../routes/jobs/shared/stream');
  assert.ok(doneEv.at - t0 < FLUSH_MS, `Terminal-Flush nach ${doneEv.at - t0} ms`);
  assert.ok(!('result' in doneEv.data));
  await a.until(ev => ev.at(-1).event === 'queue' && ev.at(-1).data.length === 0);

  // Bob sieht nichts von Alices Job.
  await sleep(50);
  assert.ok(!b.events.some(e => e.event === 'job'), 'kein job-Event im fremden Stream');
  assert.ok(b.events.filter(e => e.event === 'queue').every(e => e.data.length === 0));

  // Voller Stand inkl. result weiterhin über /jobs/:id.
  const r = await fetch(`${base}/jobs/${jobId}`, { headers: { 'x-test-user': 'alice@x' } });
  const full = await r.json();
  assert.equal(full.status, 'done');
  assert.equal(full.result.big.length, 1000);

  a.close();
  b.close();
});

test('geschlossener Stream meldet Listener am Bus ab', async () => {
  const { bus } = require('../../routes/jobs/shared/events');
  await sleep(100); // Streams der Vortests schliessen asynchron
  const before = bus.listenerCount('change');
  const s = await connect('alice@x');
  await s.until(ev => ev.some(e => e.event === 'queue'));
  assert.equal(bus.listenerCount('change'), before + 1);
  s.close();
  await sleep(50);
  assert.equal(bus.listenerCount('change'), before);
});

// ── Buch-Kanal ──────────────────────────────────────────────────────────────

async function setupBook() {
  const book = await contentStore.createBook({ name: 'Stream-Test', owner_email: 'alice@x' }, ctx('alice@x'));
  bookAccess.grantAccess(book.id, 'alice@x', 'owner', 'alice@x');
  bookAccess.grantAccess(book.id, 'bob@x', 'editor', 'alice@x');
  const page = await contentStore.createPage({ book_id: book.id, name: 'S1', html: '<p>a</p>' }, ctx('alice@x'));
  return { bookId: book.id, pageId: page.id };
}

const bookQuery = (bookId, device) => `?book_id=${bookId}&device_id=${device}`;
const bookEvents = (s) => s.events.filter(e => e.event === 'book');

test('Buch-Abo nur mit Rolle', async () => {
  const { bookId } = await setupBook();
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run('eve@x');
  const a = await connect('alice@x', bookQuery(bookId, DEV_A1));
  const e = await connect('eve@x', bookQuery(bookId, DEV_B));
  await a.until(ev => ev.some(x => x.event === 'hello'));
  await e.until(ev => ev.some(x => x.event === 'hello'));
  assert.equal(a.events.find(x => x.event === 'hello').data.book, bookId);
  assert.equal(e.events.find(x => x.event === 'hello').data.book, null);
  // Job-Kanal läuft trotzdem.
  await e.until(ev => ev.some(x => x.event === 'queue'));
  a.close();
  e.close();
});

test('Save-Anstoss: fremd und Zweitgerät ja, eigenes Gerät nein', async () => {
  const { bookId, pageId } = await setupBook();
  const a = await connect('alice@x', bookQuery(bookId, DEV_A1));
  await a.until(ev => ev.some(x => x.event === 'hello'));

  // Eigenes Gerät → Echo, kein Anstoss.
  await contentStore.savePage(pageId, { html: '<p>b</p>', device_id: DEV_A1 }, ctx('alice@x'));
  // Server-/Job-Write ohne device_id gilt ebenfalls als eigener Edit.
  await contentStore.savePage(pageId, { html: '<p>c</p>' }, ctx('alice@x'));
  await sleep(400);
  assert.equal(bookEvents(a).length, 0, 'kein Echo');

  // Fremder User → Anstoss.
  await contentStore.savePage(pageId, { html: '<p>d</p>', device_id: DEV_B }, ctx('bob@x'));
  await a.until(ev => ev.some(x => x.event === 'book'));
  assert.deepEqual(bookEvents(a)[0].data, { changed: true, presence: false, meta: [] });

  // Eigenes Zweitgerät → Anstoss.
  await contentStore.savePage(pageId, { html: '<p>e</p>', device_id: DEV_A2 }, ctx('alice@x'));
  await a.until(ev => bookEvents({ events: ev }).length >= 2);

  // Anderes Buch → nichts.
  const other = await setupBook();
  const before = bookEvents(a).length;
  await contentStore.savePage(other.pageId, { html: '<p>x</p>', device_id: DEV_B }, ctx('bob@x'));
  await sleep(400);
  assert.equal(bookEvents(a).length, before);
  a.close();
});

test('Presence-Anstoss nur bei Zustandswechsel', async () => {
  const { bookId, pageId } = await setupBook();
  const a = await connect('alice@x', bookQuery(bookId, DEV_A1));
  await a.until(ev => ev.some(x => x.event === 'hello'));

  pagePresence.ping(pageId, 'bob@x', bookId, DEV_B);
  await a.until(ev => ev.some(x => x.event === 'book'));
  assert.deepEqual(bookEvents(a)[0].data, { changed: false, presence: true, meta: [] });

  // Heartbeat derselben Row: kein neuer Anstoss.
  pagePresence.ping(pageId, 'bob@x', bookId, DEV_B);
  bookPresence.ping(bookId, 'bob@x', DEV_B, pageId);
  await a.until(ev => bookEvents({ events: ev }).length >= 2);
  bookPresence.ping(bookId, 'bob@x', DEV_B, pageId);
  await sleep(400);
  assert.equal(bookEvents(a).length, 2, 'Heartbeat ohne Wechsel feuert nicht');

  // Abmelden → Anstoss.
  pagePresence.leave(pageId, 'bob@x', DEV_B);
  await a.until(ev => bookEvents({ events: ev }).length >= 3);

  // Eigene Presence des Stream-Geräts → Echo.
  bookPresence.ping(bookId, 'alice@x', DEV_A1, pageId);
  await sleep(400);
  assert.equal(bookEvents(a).length, 3);
  a.close();
});

test('Meta-Anstoss: erreicht alle Tabs ausser dem auslösenden, nur im eigenen Buch', async () => {
  const { bookId } = await setupBook();
  const { emitBookMeta } = require('../../lib/book-events');
  const { runWithContext } = require('../../lib/log-context');
  const TAB_A = 'aaaaaaaaaaaa';
  const TAB_B = 'bbbbbbbbbbbb';
  const a = await connect('alice@x', bookQuery(bookId, DEV_A1) + '&tab_id=' + TAB_A);
  const b = await connect('alice@x', bookQuery(bookId, DEV_A1) + '&tab_id=' + TAB_B);
  await a.until(ev => ev.some(x => x.event === 'hello'));
  await b.until(ev => ev.some(x => x.event === 'hello'));

  // Ohne Tab (Leser im Share-Reader, nativer Client): alle Tabs.
  emitBookMeta(bookId, 'comments');
  await a.until(ev => ev.some(x => x.event === 'book'));
  await b.until(ev => ev.some(x => x.event === 'book'));
  assert.deepEqual(bookEvents(a)[0].data, { changed: false, presence: false, meta: ['comments'] });

  // Aus Tab A, gleiches Gerät: Tab B ja, Tab A nicht. Gleichzeitige Bereiche
  // kommen in einem Anstoss.
  runWithContext({ tabId: TAB_A }, () => { emitBookMeta(bookId, 'ideen'); emitBookMeta(bookId, 'plot'); });
  await b.until(ev => bookEvents({ events: ev }).length >= 2);
  assert.deepEqual(bookEvents(b)[1].data.meta, ['ideen', 'plot']);
  await sleep(400);
  assert.equal(bookEvents(a).length, 1, 'kein Echo an den auslösenden Tab');

  // Anderes Buch → nichts.
  const other = await setupBook();
  emitBookMeta(other.bookId, 'ideen');
  await sleep(400);
  assert.equal(bookEvents(b).length, 2);
  a.close();
  b.close();
});

test('Zugriff entzogen: gone statt Anstoss, Kanal meldet sich ab', async () => {
  const { bookId, pageId } = await setupBook();
  const { bus } = require('../../lib/book-events');
  const b = await connect('bob@x', bookQuery(bookId, DEV_B));
  await b.until(ev => ev.some(x => x.event === 'hello'));
  const listeners = bus.listenerCount('change');

  bookAccess.revokeAccess(bookId, 'bob@x');
  await contentStore.savePage(pageId, { html: '<p>geheim</p>', device_id: DEV_A1 }, ctx('alice@x'));
  await b.until(ev => ev.some(x => x.event === 'book'));
  assert.deepEqual(bookEvents(b)[0].data, { gone: true });
  assert.equal(bus.listenerCount('change'), listeners - 1);
  b.close();
});

test('Heartbeat hält eigene Presence-Rows frisch, belebt stale nicht', async () => {
  const { bookId, pageId } = await setupBook();
  const old = new Date(Date.now() - 60_000).toISOString();
  bookPresence.ping(bookId, 'alice@x', DEV_A1, null);
  db.prepare('UPDATE book_presence SET last_ping_at = ? WHERE book_id = ?').run(old, bookId);
  assert.equal(bookPresence.touch(bookId, 'alice@x', DEV_A1), true);
  const row = db.prepare('SELECT last_ping_at FROM book_presence WHERE book_id = ?').get(bookId);
  assert.ok(row.last_ping_at > old);
  assert.equal(bookPresence.touch(bookId, 'alice@x', DEV_A2), false, 'legt keine Row an');

  pagePresence.ping(pageId, 'alice@x', bookId, DEV_A1);
  db.prepare('UPDATE page_presence SET last_ping_at = ? WHERE page_id = ?').run(old, pageId);
  assert.equal(pagePresence.touchDevice(bookId, 'alice@x', DEV_A1), 1);
  const stale = new Date(Date.now() - 120_000).toISOString();
  db.prepare('UPDATE page_presence SET last_ping_at = ? WHERE page_id = ?').run(stale, pageId);
  assert.equal(pagePresence.touchDevice(bookId, 'alice@x', DEV_A1), 0, 'stale Row bleibt stale');
});

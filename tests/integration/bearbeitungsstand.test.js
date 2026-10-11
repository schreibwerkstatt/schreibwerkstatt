'use strict';
// Integration test: Bearbeitungsstand an der HTTP-Schicht (docs/bearbeitungsstand.md).
//
// Was hier haengt und im Unit-Test (tests/unit/redaktion-status.test.mjs) nicht:
//   - die Kette kommt aus dem Buchtyp: ein Roman bekommt die Manuskript-Kette,
//     eine redaktionelle Stufe wird dort mit 400 abgewiesen (und umgekehrt);
//   - das Kapitel-Setzen erreicht alle Abschnitte inkl. Unterkapitel, und das
//     Buch kommt aus dem Kapitel, nicht vom Client;
//   - der Verlauf liefert die Verteilung je Tag.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/redaktion', require('../../routes/redaktion'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { /* leerer Body ist erlaubt */ }
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['page_editorial_status_events', 'page_editorial_status', 'book_order',
    'pages', 'chapters', 'book_settings', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function ensureUser(email) {
  db.prepare(`INSERT INTO app_users (email, global_role, created_at)
              VALUES (?, 'user', ?) ON CONFLICT(email) DO NOTHING`)
    .run(email, NOW);
}

/** Buch mit Kapitel A (zwei Abschnitte) + Unterkapitel A.1 (ein Abschnitt) und
 *  Kapitel B (ein Abschnitt). */
function seed(bookId, buchtyp, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  ensureUser(user);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, `Buch ${bookId}`, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  const insChap = db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position, parent_chapter_id, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?)`);
  const chA = bookId * 10 + 1, chA1 = bookId * 10 + 2, chB = bookId * 10 + 3;
  insChap.run(chA, bookId, 'A', 1, null, NOW);
  insChap.run(chA1, bookId, 'A.1', 1, chA, NOW);
  insChap.run(chB, bookId, 'B', 2, null, NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, position, updated_at)
                              VALUES (?, ?, ?, ?, '<p>Text</p>', ?, ?)`);
  const p = (n) => bookId * 100 + n;
  insPage.run(p(1), bookId, chA, 'A-1', 1, NOW);
  insPage.run(p(2), bookId, chA, 'A-2', 2, NOW);
  insPage.run(p(3), bookId, chA1, 'A.1-1', 1, NOW);
  insPage.run(p(4), bookId, chB, 'B-1', 1, NOW);
  if (buchtyp) {
    db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at, buchtyp)
                VALUES (?, 'de', 'CH', ?, ?)`).run(bookId, NOW, buchtyp);
  }
  return { bookId, chA, chA1, chB, pages: [p(1), p(2), p(3), p(4)] };
}

test('Roman: Manuskript-Kette, Stand gilt auch ohne publizistischen Buchtyp', async () => {
  const { bookId } = seed(7701, 'roman');
  const r = await api('GET', `/redaktion/${bookId}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.journalistic, false);
  assert.deepEqual(r.json.stufen, ['rohfassung', 'ueberarbeitet', 'redigiert', 'final']);
  assert.equal(r.json.counts.ohne, 4);
});

test('die Kette haengt am Buchtyp: fremde Stufe → 400, eigene → 200', async () => {
  const roman = seed(7702, 'roman');
  let r = await api('PUT', `/redaktion/page/${roman.pages[0]}`, { status: 'freigegeben' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_VALUE');
  r = await api('PUT', `/redaktion/page/${roman.pages[0]}`, { status: 'redigiert' });
  assert.equal(r.status, 200);
  assert.equal(r.json.entry.status, 'redigiert');
  assert.equal(r.json.counts.redigiert, 1);

  const beitrag = seed(7703, 'journalismus');
  r = await api('PUT', `/redaktion/page/${beitrag.pages[0]}`, { status: 'final' });
  assert.equal(r.status, 400);
  r = await api('PUT', `/redaktion/page/${beitrag.pages[0]}`, { status: 'freigegeben' });
  assert.equal(r.status, 200);
});

test('Kapitel setzen erreicht alle Abschnitte inkl. Unterkapitel, nicht das Nachbarkapitel', async () => {
  const s = seed(7704, 'roman');
  const r = await api('PUT', `/redaktion/chapter/${s.chA}`, { status: 'ueberarbeitet' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json.entries).sort(), s.pages.slice(0, 3).map(String).sort());
  const g = await api('GET', `/redaktion/${s.bookId}`);
  for (const id of s.pages.slice(0, 3)) assert.equal(g.json.pages[String(id)]?.status, 'ueberarbeitet');
  assert.equal(g.json.pages[String(s.pages[3])], undefined, 'Kapitel B bleibt unberuehrt');

  // Entfernen geht ueber denselben Weg.
  const c = await api('PUT', `/redaktion/chapter/${s.chA1}`, { status: null });
  assert.equal(c.status, 200);
  assert.equal(c.json.entries[String(s.pages[2])], null);
});

test('Kapitel eines fremden Buchs: 403', async () => {
  const fremd = seed(7705, 'roman', 'fremd@test.dev');
  const r = await api('PUT', `/redaktion/chapter/${fremd.chA}`, { status: 'final' });
  assert.equal(r.status, 403);
});

test('Verlauf: je Tag die Verteilung nach dem letzten Wechsel', async () => {
  const s = seed(7706, 'roman');
  await api('PUT', `/redaktion/page/${s.pages[0]}`, { status: 'rohfassung' });
  await api('PUT', `/redaktion/page/${s.pages[0]}`, { status: 'final' });
  await api('PUT', `/redaktion/page/${s.pages[1]}`, { status: 'redigiert' });
  // Dieselbe Stufe erneut: Anker frisch, aber kein Ereignis.
  await api('PUT', `/redaktion/page/${s.pages[1]}`, { status: 'redigiert' });
  const n = db.prepare('SELECT COUNT(*) AS n FROM page_editorial_status_events').get().n;
  assert.equal(n, 3);

  const h = await api('GET', `/redaktion/${s.bookId}/history`);
  assert.equal(h.status, 200);
  assert.equal(h.json.daily.length, 1, 'alle Wechsel am selben Tag');
  const day = h.json.daily[0];
  assert.equal(day.final, 1);
  assert.equal(day.redigiert, 1);
  assert.equal(day.rohfassung, 0, 'der Zwischenstand des Tages zaehlt nicht');
});

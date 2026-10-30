'use strict';
// Integration: Kontext-Aufbau und Lebenszyklus des Buch-Chats.
//   - Seiten-Cache des klassischen Pfads leert sich bei jedem Schreibweg der
//     Content-Store-Facade (Buch-Bus 'change'), nur für das betroffene Buch.
//   - Volltext-Entscheidung: fehlende page_stats zählen als unbekannt (live
//     gemessen), nicht als 0.
//   - Textbudget: kein fester Boden über das Input-Budget hinaus — erst Verlauf,
//     dann Gliederung kürzen.
//   - DELETE /chat/session/:id bricht einen laufenden Job der Session ab.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'bcctx-owner@test.dev';
const BOOK = 9611;
const OTHER_BOOK = 9612;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER });
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Kontextbuch' }, { id: OTHER_BOOK, name: 'Anderes' }],
    chapters: [{ id: 96111, book_id: BOOK, name: 'K1', position: 1 }],
    pages: [
      { id: 961101, book_id: BOOK, name: 'Eins', chapter_id: 96111, position: 1, updated_at: NOW },
      { id: 961102, book_id: BOOK, name: 'Zwei', chapter_id: 96111, position: 2, updated_at: NOW },
      { id: 961201, book_id: OTHER_BOOK, name: 'Fremd', position: 1, updated_at: NOW },
    ],
    pageBodies: {
      961101: '<p>Kurzer Text.</p>',
      961102: `<p>${'Langer Abschnitt ohne Statistik. '.repeat(40)}</p>`,
      961201: '<p>Anderes Buch.</p>',
    },
  });
  require('../../db/book-access').grantAccess(BOOK, OWNER, 'editor', OWNER);
  // Nur Abschnitt «Eins» hat Stats; «Zwei» (der lange) hat keine Zeile.
  db.prepare('INSERT INTO page_stats (page_id, book_id, words, chars) VALUES (?, ?, ?, ?)').run(961101, BOOK, 2, 12);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: OWNER } }; next(); });
  app.use('/chat', require('../../routes/chat'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

test('Seiten-Cache: Speichern über den Content-Store leert genau das betroffene Buch', async () => {
  const { bookPageCache } = require('../../routes/jobs/chat/shared');
  const contentStore = require('../../lib/content-store');
  bookPageCache.set(`${BOOK}:${OWNER}`, { pages: [], loadedAt: Date.now() });
  bookPageCache.set(`${BOOK}:x@y`, { pages: [], loadedAt: Date.now() });
  bookPageCache.set(`${OTHER_BOOK}:${OWNER}`, { pages: [], loadedAt: Date.now() });
  await contentStore.savePage(961101, { html: '<p>Kurzer Text, neu.</p>' }, null);
  assert.equal(bookPageCache.has(`${BOOK}:${OWNER}`), false);
  assert.equal(bookPageCache.has(`${BOOK}:x@y`), false);
  assert.equal(bookPageCache.has(`${OTHER_BOOK}:${OWNER}`), true, 'anderes Buch bleibt');
  bookPageCache.clear();
});

test('Volltext-Grösse: Abschnitt ohne page_stats wird live gemessen statt als 0 gezählt', async () => {
  const { _bookTextChars } = require('../../routes/jobs/chat/book-chat');
  const chars = await _bookTextChars(BOOK, `${BOOK}:${OWNER}`);
  assert.ok(chars > 1000, `fehlende Stats zählen mit (${chars})`);
  // Frischer Cache ist exakt und hat Vorrang.
  const { bookPageCache } = require('../../routes/jobs/chat/shared');
  bookPageCache.set(`${BOOK}:${OWNER}`, { pages: [{ text: 'abc' }, { text: 'de' }], loadedAt: Date.now() });
  assert.equal(await _bookTextChars(BOOK, `${BOOK}:${OWNER}`), 5);
  bookPageCache.clear();
});

test('Textbudget: kleiner Kontext → Verlauf/Gliederung gekürzt, nie über das Input-Budget', () => {
  const { _fitClassicBudget } = require('../../routes/jobs/chat/book-chat');
  const history = [
    { role: 'user', content: 'a'.repeat(4000) }, { role: 'assistant', content: 'b'.repeat(4000) },
    { role: 'user', content: 'c'.repeat(100) }, { role: 'assistant', content: 'd'.repeat(100) },
  ];
  const r = _fitClassicBudget({
    inputBudgetChars: 20000, fixedChars: 6000, history,
    buildOutline: (max) => 'G'.repeat(Math.min(max, 1500)),
  });
  assert.equal(r.historyTrimmed, 2, 'älteste Runde fällt zuerst');
  assert.equal(r.outlineDropped, false, 'Gliederung bleibt, solange das Verlauf-Kürzen reicht');
  assert.equal(r.history[0].role, 'user', 'Verlauf beginnt weiter mit einer Frage');
  const total = 6000 + r.historyChars + (r.gliederung?.length || 0) + r.textBudget;
  assert.ok(total <= 20000, `Summe ${total} sprengt das Budget nicht`);

  // Reicht auch das Kürzen nicht, bleibt das Textbudget klein statt eines festen Bodens.
  const tight = _fitClassicBudget({ inputBudgetChars: 10000, fixedChars: 9800, history: [], buildOutline: () => 'G'.repeat(2000) });
  assert.equal(tight.outlineDropped, true);
  assert.ok(tight.textBudget <= 200);

  // Genug Platz: nichts gekürzt.
  const roomy = _fitClassicBudget({ inputBudgetChars: 400000, fixedChars: 20000, history, buildOutline: () => 'G' });
  assert.equal(roomy.historyTrimmed, 0);
  assert.equal(roomy.outlineDropped, false);
});

test('DELETE /chat/session/:id bricht den laufenden Job der Session ab', async () => {
  const { createJob, jobs } = require('../../routes/jobs/shared');
  const sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)",
  ).run(BOOK, OWNER, NOW, NOW).lastInsertRowid;
  const jobId = createJob('book-chat', BOOK, OWNER, 'job.label.bookChat', null, sid);
  assert.equal(jobs.get(jobId).status, 'queued');
  const r = await fetch(`${baseUrl}/chat/session/${sid}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(jobs.get(jobId).status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE id = ?').get(sid).n, 0);
});

test('Ganzes Buch: minTextChars verdrängt Verlauf und Gliederung, fullBookPossible misst gegen das Höchstbudget', async () => {
  const { _fitClassicBudget, fullBookPossible } = require('../../routes/jobs/chat/book-chat');
  const history = [{ role: 'user', content: 'a'.repeat(3000) }, { role: 'assistant', content: 'b'.repeat(3000) }];
  const r = _fitClassicBudget({
    inputBudgetChars: 20000, fixedChars: 6000, history,
    buildOutline: () => 'G'.repeat(1500), minTextChars: 12000,
  });
  assert.equal(r.historyTrimmed, 2);
  assert.equal(r.outlineDropped, false, 'Gliederung bleibt, wenn das Verlauf-Kürzen schon reicht');
  assert.ok(r.textBudget >= 12000 * 0.98);
  const all = _fitClassicBudget({ inputBudgetChars: 20000, fixedChars: 6000, history, buildOutline: () => 'G'.repeat(1500), minTextChars: 14000 });
  assert.equal(all.outlineDropped, true, 'reicht der Verlauf nicht, weicht auch die Gliederung');

  // Kontextfenster gross genug → möglich; winzig → nicht.
  assert.equal(await fullBookPossible({ bookId: BOOK, userEmail: OWNER, aiCfg: { inputBudgetChars: 400000 }, messageLen: 10 }), true);
  assert.equal(await fullBookPossible({ bookId: BOOK, userEmail: OWNER, aiCfg: { inputBudgetChars: 9000 }, messageLen: 10 }), false);
});

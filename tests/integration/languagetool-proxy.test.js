'use strict';
// Integration-Test fuer /languagetool/check. Mockt das Upstream-LT-API via
// globalem fetch-Stub: enabled-OK, disabled, upstream-Fehler, Timeout, Absatz-
// Cache, Filter beim Ausliefern (Woerterbuch pro User, Buchnamen, abgeschaltete
// Regeln), Buch-ACL, Abbruch der Worker. Keine echte LT-Instanz noetig.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let server;
let baseUrl;
let originalFetch;
let fetchHandler = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const appSettings = require('../../lib/app-settings');
    const ltRouter = require('../../routes/languagetool');
    const app = express();
    // Fake-Session-Middleware: liefert immer einen User, damit Session-Guard
    // in der Route durchgeht (Route hat selbst keinen Guard — Express-Mount in
    // server.js bringt ihn, hier mocken wir einen User-Eintrag fuer Logging).
    // Header `x-test-user` schaltet den User um (Mehrbenutzer-Faelle).
    app.use((req, _res, next) => {
      req.session = { user: { email: req.get('x-test-user') || 'tester@test.dev' } };
      next();
    });
    app.use('/languagetool', ltRouter);
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
    server.on('error', reject);
    // Sanity export
    void appSettings;
  });
}

test.before(async () => {
  ctx = bootstrap();
  originalFetch = global.fetch;
  // global fetch wird vom Proxy fuer den LT-Upstream-Call genutzt; im Test
  // ueber `fetchHandler` umlenken. fetchHandler === null -> Original durchreichen.
  global.fetch = async (url, opts) => {
    if (fetchHandler && String(url).includes('/v2/check')) {
      return fetchHandler(url, opts);
    }
    return originalFetch(url, opts);
  };
  await startServer();
});

test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(r => server.close(r));
  ctx.cleanup();
});

function setLT({ enabled, url, picky = false }) {
  const { db } = require('../../db/connection');
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
    VALUES (?, ?, 0, datetime('now'), 'test')
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `);
  upsert.run('languagetool.enabled', JSON.stringify(enabled));
  upsert.run('languagetool.url',     JSON.stringify(url));
  upsert.run('languagetool.picky',   JSON.stringify(picky));
  const appSettings = require('../../lib/app-settings');
  appSettings.clearCache();
}

// Absatz-Cache ist textbasiert und lebt testuebergreifend — jeder Test startet leer.
test.beforeEach(() => {
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM languagetool_para_cache').run();
});

test('disabled -> 404 languagetool_disabled', async () => {
  setLT({ enabled: false, url: 'http://lt.lan:8010' });
  fetchHandler = null;
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'languagetool_disabled');
});

test('enabled but no URL -> 404 disabled', async () => {
  setLT({ enabled: true, url: '' });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 404);
});

test('upstream OK -> matches passed through', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response(JSON.stringify({
    language: { code: 'de-CH' },
    matches: [
      { message: 'Tippfehler', offset: 0, length: 5, rule: { id: 'GERMAN_SPELLER', category: { id: 'TYPOS', name: 'Rechtschreibung' } }, replacements: [{ value: 'hallo' }] },
    ],
    software: { name: 'LanguageTool', version: '6.0' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo welt', language: 'de-CH' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(Array.isArray(j.matches), true);
  assert.equal(j.matches.length, 1);
  assert.equal(j.matches[0].rule.id, 'GERMAN_SPELLER');
});

test('upstream 500 -> 502 languagetool_upstream', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response('boom', { status: 500 });
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'languagetool_upstream');
  assert.equal(j.upstream_status, 500);
});

test('upstream abort -> 408 timeout', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async (_url, opts) => {
    // Signal-respektierender Abort: AbortError werfen.
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
      // Triggern: bewusst abort werfen statt warten (vermeidet 10s-Wait).
      const err = new Error('aborted');
      err.name = 'AbortError';
      setTimeout(() => reject(err), 5);
    });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hallo' }),
  });
  assert.equal(r.status, 408);
});

test('empty text -> empty matches without upstream call', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  let called = false;
  fetchHandler = async () => { called = true; return new Response('{}', { status: 200 }); };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { matches: [] });
  assert.equal(called, false);
});

test('URL with /v2 suffix is stripped before forwarding', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010/v2' });
  let capturedUrl = '';
  fetchHandler = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ matches: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(r.status, 200);
  assert.equal(capturedUrl, 'http://lt.lan:8010/v2/check');
});

test('chunking: >50KB text is split, matches merged with absolute offsets', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  // Bau zwei 30KB-Paragraphen mit unterschiedlichem Inhalt; Chunker macht 2 Calls.
  const p1 = 'a'.repeat(30_000);
  const p2 = 'b'.repeat(30_000);
  const text = `${p1}\n\n${p2}`;
  let callCount = 0;
  const seenTexts = [];
  fetchHandler = async (_url, opts) => {
    callCount++;
    const params = new URLSearchParams(opts.body);
    const chunkText = params.get('text');
    seenTexts.push(chunkText.slice(0, 10));
    // Match-Offset 5 in jedem Chunk -> nach Adjust: 0 + 5 = 5, dann (30_000+2) + 5 fuer den 2. Chunk.
    return new Response(JSON.stringify({
      matches: [
        { message: 'm', offset: 5, length: 3, rule: { id: 'X' }, replacements: [] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language: 'de-DE' }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(callCount, 2);
  assert.equal(j.chunks, 2);
  assert.equal(j.matches.length, 2);
  // Erster match bei offset 5, zweiter offset 5 + Position des 2. Chunks im Original.
  assert.equal(j.matches[0].offset, 5);
  assert.ok(j.matches[1].offset >= 30_000);
});

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function seedUser(email) {
  const { db } = require('../../db/connection');
  db.prepare(`INSERT OR IGNORE INTO app_users (email, display_name, global_role, status, created_at) VALUES (?, ?, 'user', 'active', ${NOW})`)
    .run(email, email);
}

function seedBook(bookId, members = []) {
  const { db } = require('../../db/connection');
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${NOW}, ${NOW})`).run(bookId, `lt-book-${bookId}`);
  for (const [email, role] of members) {
    seedUser(email);
    db.prepare('INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, ?)').run(bookId, email, role);
  }
}

function dropBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM books WHERE book_id = ?').run(bookId);
}

function check(body, user) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  return originalFetch(`${baseUrl}/languagetool/check`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// Upstream-Stub: meldet jedes Vorkommen der Woerter in `words` als Tippfehler
// (Offsets relativ zum gesendeten Text, mit passendem context).
function spellerStub(words, counter) {
  return async (_url, opts) => {
    counter.calls++;
    const text = new URLSearchParams(opts.body).get('text');
    counter.texts.push(text);
    const matches = [];
    for (const w of words) {
      let i = text.indexOf(w);
      while (i >= 0) {
        matches.push({
          message: 'Tippfehler', offset: i, length: w.length,
          rule: { id: 'GERMAN_SPELLER_RULE', category: { id: 'TYPOS' } },
          context: { text, offset: i, length: w.length },
          replacements: [],
        });
        i = text.indexOf(w, i + 1);
      }
    }
    return new Response(JSON.stringify({ matches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('para-cache: unveraenderte Absaetze gehen nicht erneut an LT, Offsets bleiben absolut', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  const counter = { calls: 0, texts: [] };
  fetchHandler = spellerStub(['Fehlr'], counter);

  const a = 'Erster Absatz mit Fehlr.';
  const b = 'Zweiter Absatz ohne.';
  const r1 = await (await check({ text: `${a}\n\n${b}`, language: 'de-DE' })).json();
  assert.equal(counter.calls, 1);
  assert.equal(r1.cached, 0);
  assert.equal(r1.matches.length, 1);
  assert.equal(r1.matches[0].offset, a.indexOf('Fehlr'));

  // Nur Absatz b aendert sich; a kommt aus dem Cache, sein Treffer verschiebt
  // sich mit, weil davor ein neuer Absatz steht.
  const pre = 'Neuer Anfang mit Fehlr.';
  const text2 = `${pre}\n\n${a}\n\n${b} Ergaenzt.`;
  const r2 = await (await check({ text: text2, language: 'de-DE' })).json();
  assert.equal(counter.calls, 2);
  assert.equal(r2.cached, 1, 'Absatz a aus dem Cache');
  assert.ok(!counter.texts[1].includes(a), 'Absatz a nicht erneut gesendet');
  assert.deepEqual(r2.matches.map(m => m.offset), [
    pre.indexOf('Fehlr'),
    pre.length + 2 + a.indexOf('Fehlr'),
  ]);

  // Identischer Text: alles aus dem Cache.
  const r3 = await (await check({ text: text2, language: 'de-DE' })).json();
  assert.equal(counter.calls, 2, 'kein Upstream-Call');
  assert.equal(r3.cached, 3);
  assert.equal(r3.matches.length, 2);
});

test('Woerterbuch eines Users wirkt nicht fuer einen anderen (geteilter Cache, Filter beim Ausliefern)', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  seedBook(900002, [['tester@test.dev', 'owner'], ['kollege@test.dev', 'editor']]);
  const dict = require('../../db/user-dictionary');
  const counter = { calls: 0, texts: [] };
  fetchHandler = spellerStub(['Kantifest'], counter);
  const body = { text: 'Wir feiern Kantifest am Wochenende.', bookId: 900002 };

  const r1 = await (await check(body)).json();
  assert.equal(r1.matches.length, 1);

  dict.add('tester@test.dev', { word: 'Kantifest', bookId: 0, lang: '*' });
  const r2 = await (await check(body)).json();
  assert.equal(r2.cached, 1);
  assert.equal(r2.matches.length, 0, 'eigenes Woerterbuch greift sofort, auch auf Cache-Hit');

  const r3 = await (await check(body, 'kollege@test.dev')).json();
  assert.equal(r3.cached, 1);
  assert.equal(r3.matches.length, 1, 'Kollege sieht den Treffer weiterhin');

  dict.remove('tester@test.dev', { word: 'Kantifest', bookId: 0, lang: '*' });
  const r4 = await (await check(body)).json();
  assert.equal(r4.matches.length, 1, 'Entfernen greift sofort');
  assert.equal(counter.calls, 1);

  dropBook(900002);
});

test('Figuren- und Ortsnamen des Buchs gelten als richtig geschrieben (inkl. Genitiv)', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  seedBook(900003, [['tester@test.dev', 'owner']]);
  const { db } = require('../../db/connection');
  db.prepare(`INSERT INTO figures (book_id, fig_id, name, kurzname, user_email, updated_at) VALUES (?, 'f1', 'Ilvana Brest', 'Ilvi', ?, ${NOW})`)
    .run(900003, 'tester@test.dev');
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, 'l1', 'Kaltwasserau', ?, ${NOW})`)
    .run(900003, 'tester@test.dev');
  const counter = { calls: 0, texts: [] };
  fetchHandler = spellerStub(['Ilvanas', 'Ilvi', 'Kaltwasserau', 'Quatschwort'], counter);
  const r = await (await check({ text: 'Ilvanas Hund lief mit Ilvi nach Kaltwasserau. Quatschwort.', bookId: 900003 })).json();
  assert.deepEqual(r.matches.map(m => m.context.text.substr(m.context.offset, m.context.length)), ['Quatschwort']);
  dropBook(900003);
});

test('abgeschaltete Regel faellt raus — pro Buch und global', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  seedBook(900004, [['tester@test.dev', 'owner']]);
  seedBook(900005, [['tester@test.dev', 'owner']]);
  const ltRules = require('../../db/languagetool-rules');
  fetchHandler = spellerStub(['Fehlr'], { calls: 0, texts: [] });
  const text = 'Ein Fehlr.';
  ltRules.add('tester@test.dev', { ruleId: 'GERMAN_SPELLER_RULE', bookId: 900004 });
  assert.equal((await (await check({ text, bookId: 900004 })).json()).matches.length, 0);
  assert.equal((await (await check({ text, bookId: 900005 })).json()).matches.length, 1, 'anderes Buch unberuehrt');
  ltRules.add('tester@test.dev', { ruleId: 'GERMAN_SPELLER_RULE', bookId: 0 });
  assert.equal((await (await check({ text, bookId: 900005 })).json()).matches.length, 0);
  ltRules.remove('tester@test.dev', { ruleId: 'GERMAN_SPELLER_RULE', bookId: 0 });
  dropBook(900004);
  dropBook(900005);
});

test('fremdes Buch -> 403, kein Upstream-Call', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  seedBook(900006, [['owner@test.dev', 'owner']]);
  const counter = { calls: 0, texts: [] };
  fetchHandler = spellerStub([], counter);
  const r = await check({ text: 'Hallo', bookId: 900006 });
  assert.equal(r.status, 403);
  assert.equal(counter.calls, 0);
  dropBook(900006);
});

test('Upstream-Fehler bricht die uebrigen Worker ab', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  let calls = 0;
  fetchHandler = (_url, opts) => {
    calls++;
    if (calls === 1) return Promise.resolve(new Response('boom', { status: 500 }));
    // Antwortet nach 20 ms — es sei denn, der Proxy bricht vorher ab. Ohne
    // Abbruch holten die Worker danach Anfrage 5 und 6.
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response('{"matches":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } })), 20);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  };
  // 6 Absaetze a 30 KB -> 6 Upstream-Anfragen, Pool 4.
  const text = Array.from({ length: 6 }, (_, i) => String.fromCharCode(97 + i).repeat(30_000)).join('\n\n');
  const r = await check({ text, language: 'de-DE' });
  assert.equal(r.status, 502);
  await new Promise(res => setTimeout(res, 100));
  assert.equal(calls, 4, 'Anfragen 5 und 6 starten nicht mehr');
});

test('text >TEXT_MAX (500KB) -> 413', async () => {
  setLT({ enabled: true, url: 'http://lt.lan:8010' });
  fetchHandler = async () => new Response('{}', { status: 200 });
  // 600KB text.
  const text = 'x'.repeat(600_000);
  const r = await originalFetch(`${baseUrl}/languagetool/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  assert.equal(r.status, 413);
  const j = await r.json();
  assert.equal(j.error, 'text_too_large');
});

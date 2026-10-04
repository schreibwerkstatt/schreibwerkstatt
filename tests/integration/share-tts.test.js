'use strict';
// Integration-Test fuer die public, token-skopierte Vorlese-Route
// POST /share/:token/tts (Share-Reader). Ohne Session — Mount nur des
// Share-Routers (wie share-reader-live). Upstream via globalem fetch-Stub.
// Prueft: disabled->404, unbekannter/abgelaufener Token->404, enabled+OK->Audio,
// Voice aus der Buch-Locale, kein Text->400, Secret bleibt server-seitig.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const tmp = path.join('/tmp', `share-tts-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-share-tts';

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const sl = require('../../db/share-links');
const appSettings = require('../../lib/app-settings');

const express = require('express');
const shareRouter = require('../../routes/share');

const OWNER = 'autor@tts.test';
const BOOK_ID = 93001;
const PAGE_ID = 93201;

let server, baseUrl, originalFetch, fetchHandler = null;

function setTts({ enabled, host = 'http://tts.lan:8880', voice = 'default_voice', voiceDe = '', apiKey = '' }) {
  appSettings.set('tts.enabled', enabled, { updatedBy: 'test' });
  appSettings.set('tts.host', host, { updatedBy: 'test' });
  appSettings.set('tts.model', 'tts-1', { updatedBy: 'test' });
  appSettings.set('tts.voice', voice, { updatedBy: 'test' });
  appSettings.set('tts.voice.de', voiceDe, { updatedBy: 'test' });
  appSettings.set('tts.format', 'mp3', { updatedBy: 'test' });
  appSettings.set('tts.speed', 1, { updatedBy: 'test' });
  if (apiKey) appSettings.set('tts.api_key', apiKey, { updatedBy: 'test' });
  appSettings.clearCache();
}

function seed() {
  const now = new Date().toISOString();
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Autor' });
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(BOOK_ID, 'TTS-Buch', now, now);
  db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at) VALUES (?, ?, ?, ?)`)
    .run(BOOK_ID, 'de', 'CH', now);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, ?, 0, ?, ?)`)
    .run(PAGE_ID, BOOK_ID, 'Seite', now, '<p>Hallo Welt.</p>');
}

test.before(async () => {
  seed();
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (fetchHandler && String(url).includes('/v1/audio/speech')) return fetchHandler(url, opts);
    return originalFetch(url, opts);
  };
  const app = express();
  app.use('/share', shareRouter);
  await new Promise((res) => { server = app.listen(0, res); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// Audio-Cache, Wortmengen-Cache und Ratenlimit sind Prozess-Zustand — pro Test frisch.
test.beforeEach(() => {
  require('../../lib/tts-synth').clearAudioCache();
  require('../../lib/share-tts-guard')._resetForTests();
  require('../../lib/share-ratelimit')._resetAll();
});

test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(r => server.close(r));
});

function postTts(token, body) {
  return originalFetch(`${baseUrl}/share/${token}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('disabled -> 404 tts_disabled', async () => {
  setTts({ enabled: false });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  fetchHandler = null;
  const r = await postTts(link.token, { text: 'Hallo.' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'tts_disabled');
});

test('unbekannter Token -> 404', async () => {
  setTts({ enabled: true });
  const r = await postTts('abcdef0123456789abcd', { text: 'Hallo.' });
  assert.equal(r.status, 404);
});

test('leerer Text -> 400 tts_no_text', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  const r = await postTts(link.token, { text: '   ' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'tts_no_text');
});

test('enabled + OK -> Audio durchgereicht, Voice aus Buch-Locale, Secret server-seitig', async () => {
  setTts({ enabled: true, voice: 'default_voice', voiceDe: 'de_voice', apiKey: 'sk-secret-xyz' });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  let sawUrl = '', sawAuth = null, sawBody = null;
  fetchHandler = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts.headers?.Authorization || null;
    sawBody = JSON.parse(opts.body);
    return new Response(Buffer.from([0x49, 0x44, 0x33, 0x04]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const r = await postTts(link.token, { text: 'Hallo Welt.' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, 4);
  assert.equal(sawUrl, 'http://tts.lan:8880/v1/audio/speech');
  assert.equal(sawAuth, 'Bearer sk-secret-xyz'); // Key nur upstream, nie im Response
  assert.equal(sawBody.input, 'Hallo Welt.');
  assert.equal(sawBody.voice, 'de_voice'); // de-CH -> tts.voice.de gewinnt
});

test('abgelaufener Link -> 404', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), link.token);
  const r = await postTts(link.token, { text: 'Hallo.' });
  assert.equal(r.status, 404);
});

test('upstream 500 -> 502 tts_upstream', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  fetchHandler = async () => new Response('boom', { status: 500 });
  const r = await postTts(link.token, { text: 'Hallo.' });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'tts_upstream');
});

test('Text, der nicht aus dem geteilten Inhalt stammt -> 422, kein Upstream-Call', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  let called = false;
  fetchHandler = async () => { called = true; return new Response(Buffer.from([1]), { status: 200 }); };
  const r = await postTts(link.token, { text: 'Kaufen Sie jetzt guenstige Uhren im Angebot.' });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'tts_text_not_shared');
  assert.equal(called, false);
});

test('aufbereiteter Sprechtext aus dem Inhalt wird akzeptiert (Wort-Ebene, nicht Teilstring)', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  fetchHandler = async () => new Response(Buffer.from([1]), { status: 200 });
  // Client normalisiert Satzzeichen (normalizeForSpeech) — die Woerter bleiben.
  const r = await postTts(link.token, { text: 'Hallo, Welt' });
  assert.equal(r.status, 200);
});

test('Ratenlimit pro Token + IP -> 429 mit Retry-After', async () => {
  setTts({ enabled: true });
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  const rl = require('../../lib/share-ratelimit');
  // Kontingent bis auf den letzten Platz verbrauchen (gleiche IP wie der Test-Client).
  const ipHash = rl.hashIp('::ffff:127.0.0.1');
  for (let i = 0; i < rl.TTS_MAX_PER_WINDOW; i++) rl.checkTts(link.token, ipHash);
  fetchHandler = async () => new Response(Buffer.from([1]), { status: 200 });
  const r = await postTts(link.token, { text: 'Hallo.' });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await r.json()).error, 'tts_rate_limited');
});

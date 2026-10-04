'use strict';
// Integration-Test fuer /tts/speak. Mockt den OpenAI-kompatiblen Speech-
// Upstream via globalem fetch-Stub und prueft: disabled->404, kein Text->400,
// enabled->Forward+Audio-Bytes, Upstream-Fehler->502, Timeout->408, voice/speed
// werden geforwarded, Secret bleibt server-seitig, /v1-Suffix wird gestrippt.

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
    const ttsRouter = require('../../routes/tts');
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: 'tester@test.dev' } }; next(); });
    app.use('/tts', ttsRouter);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

test.before(async () => {
  // Encrypted-Key (tts.api_key) braucht SESSION_SECRET fuer crypto.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-tts';
  ctx = bootstrap();
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (fetchHandler && String(url).includes('/v1/audio/speech')) {
      return fetchHandler(url, opts);
    }
    return originalFetch(url, opts);
  };
  await startServer();
});

// Der Synthese-Kern cacht erfolgreiches Audio; jeder Test startet ohne Cache,
// sonst beantwortete ein frueherer Erfolg einen spaeteren Fehlerfall.
test.beforeEach(() => { require('../../lib/tts-synth').clearAudioCache(); });

test.after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(r => server.close(r));
  ctx.cleanup();
});

function setTts({ enabled, host, model = 'tts-1', voice = '', voiceDe = '', voiceEn = '', format = 'mp3', speed = 1, apiKey = '' }) {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('tts.enabled', enabled, { updatedBy: 'test' });
  appSettings.set('tts.host', host, { updatedBy: 'test' });
  appSettings.set('tts.model', model, { updatedBy: 'test' });
  appSettings.set('tts.voice', voice, { updatedBy: 'test' });
  appSettings.set('tts.voice.de', voiceDe, { updatedBy: 'test' });
  appSettings.set('tts.voice.en', voiceEn, { updatedBy: 'test' });
  appSettings.set('tts.format', format, { updatedBy: 'test' });
  appSettings.set('tts.speed', speed, { updatedBy: 'test' });
  if (apiKey) appSettings.set('tts.api_key', apiKey, { updatedBy: 'test' });
  appSettings.clearCache();
}

function postSpeak(body, { query = '' } = {}) {
  return originalFetch(`${baseUrl}/tts/speak${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('disabled -> 404 tts_disabled', async () => {
  setTts({ enabled: false, host: 'http://tts.lan:8880' });
  fetchHandler = null;
  const r = await postSpeak({ text: 'Hallo.' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'tts_disabled');
});

test('enabled but no host -> 404 disabled', async () => {
  setTts({ enabled: true, host: '' });
  const r = await postSpeak({ text: 'Hallo.' });
  assert.equal(r.status, 404);
});

test('empty text -> 400 tts_no_text', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880' });
  const r = await postSpeak({ text: '   ' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'tts_no_text');
});

test('upstream OK -> Audio-Bytes durchgereicht, voice/speed geforwarded, Secret server-seitig', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880', voice: 'af_heart', speed: 1.25, apiKey: 'sk-secret-123' });
  let sawAuth = null;
  let sawUrl = '';
  let sawBody = null;
  fetchHandler = async (url, opts) => {
    sawUrl = String(url);
    sawAuth = opts.headers?.Authorization || opts.headers?.authorization || null;
    sawBody = JSON.parse(opts.body);
    return new Response(Buffer.from([0x49, 0x44, 0x33, 0x04]), {
      status: 200, headers: { 'Content-Type': 'audio/mpeg' },
    });
  };
  const r = await postSpeak({ text: 'Hallo Welt.' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, 4);
  assert.equal(sawUrl, 'http://tts.lan:8880/v1/audio/speech');
  assert.equal(sawAuth, 'Bearer sk-secret-123');
  assert.equal(sawBody.input, 'Hallo Welt.');
  assert.equal(sawBody.voice, 'af_heart');
  assert.equal(sawBody.speed, 1.25);
  assert.equal(sawBody.response_format, 'mp3');
});

test('Buch-Locale waehlt die Stimme (de-CH -> tts.voice.de schlaegt Default)', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880', voice: 'default_voice', voiceDe: 'de_voice', voiceEn: 'en_voice' });
  const { db } = require('../../db/connection');
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${now}, ${now})`)
    .run(920001, 'tts-voice-book');
  db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at) VALUES (?, ?, ?, ${now})`)
    .run(920001, 'de', 'CH');
  db.prepare('INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, ?)').run(920001, 'tester@test.dev', 'viewer');
  let sawVoice = null;
  fetchHandler = async (_url, opts) => {
    sawVoice = JSON.parse(opts.body).voice;
    return new Response(Buffer.from([1]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const r = await postSpeak({ text: 'Hallo.' }, { query: '?bookId=920001' });
  assert.equal(r.status, 200);
  assert.equal(sawVoice, 'de_voice');
  db.prepare('DELETE FROM book_access WHERE book_id = ?').run(920001);
  db.prepare('DELETE FROM book_settings WHERE book_id = ?').run(920001);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(920001);
});

test('ohne Locale-Stimme faellt es auf die Standard-Stimme zurueck', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880', voice: 'default_voice', voiceDe: '', voiceEn: '' });
  const { db } = require('../../db/connection');
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${now}, ${now})`)
    .run(920002, 'tts-voice-book2');
  db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at) VALUES (?, ?, ?, ${now})`)
    .run(920002, 'de', 'CH');
  db.prepare('INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, ?)').run(920002, 'tester@test.dev', 'viewer');
  let sawVoice = null;
  fetchHandler = async (_url, opts) => {
    sawVoice = JSON.parse(opts.body).voice;
    return new Response(Buffer.from([1]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const r = await postSpeak({ text: 'Hallo.' }, { query: '?bookId=920002' });
  assert.equal(r.status, 200);
  assert.equal(sawVoice, 'default_voice');
  db.prepare('DELETE FROM book_access WHERE book_id = ?').run(920002);
  db.prepare('DELETE FROM book_settings WHERE book_id = ?').run(920002);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(920002);
});

test('host mit /v1-Suffix wird gestrippt', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880/v1' });
  let sawUrl = '';
  fetchHandler = async (url) => {
    sawUrl = String(url);
    return new Response(Buffer.from([1, 2]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  };
  const r = await postSpeak({ text: 'x' });
  assert.equal(r.status, 200);
  assert.equal(sawUrl, 'http://tts.lan:8880/v1/audio/speech');
});

test('upstream 500 -> 502 tts_upstream', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880' });
  fetchHandler = async () => new Response('boom', { status: 500 });
  const r = await postSpeak({ text: 'x' });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.error, 'tts_upstream');
  assert.equal(j.upstream_status, 500);
});

test('upstream abort -> 408 tts_timeout', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880' });
  fetchHandler = async (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
    const err = new Error('aborted'); err.name = 'AbortError';
    setTimeout(() => reject(err), 5);
  });
  const r = await postSpeak({ text: 'x' });
  assert.equal(r.status, 408);
  assert.equal((await r.json()).error, 'tts_timeout');
});

test('fremdes Buch -> 403, kein Upstream-Call (Buch-ID waehlt die Stimme)', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880' });
  const { db } = require('../../db/connection');
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ${now}, ${now})`)
    .run(920003, 'tts-foreign-book');
  let called = false;
  fetchHandler = async () => { called = true; return new Response(Buffer.from([1]), { status: 200 }); };
  const r = await postSpeak({ text: 'Hallo.' }, { query: '?bookId=920003' });
  assert.equal(r.status, 403);
  assert.equal(called, false);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(920003);
});

test('gleicher Text + gleiche Einstellungen -> zweiter Aufruf aus dem Audio-Cache', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880', voice: 'v1' });
  let calls = 0;
  fetchHandler = async () => { calls++; return new Response(Buffer.from([7, 7]), { status: 200 }); };
  assert.equal((await postSpeak({ text: 'Noch einmal.' })).status, 200);
  const r = await postSpeak({ text: 'Noch einmal.' });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).length, 2);
  assert.equal(calls, 1);
  // Andere Stimme → anderes Audio, kein Cache-Treffer.
  setTts({ enabled: true, host: 'http://tts.lan:8880', voice: 'v2' });
  assert.equal((await postSpeak({ text: 'Noch einmal.' })).status, 200);
  assert.equal(calls, 2);
});

test('Alt-Einstellung pcm faellt auf mp3 zurueck (kein Browser spielt rohes PCM)', async () => {
  setTts({ enabled: true, host: 'http://tts.lan:8880' });
  const { db } = require('../../db/connection');
  db.prepare("UPDATE app_settings SET value_json = ? WHERE key = 'tts.format'").run(JSON.stringify('pcm'));
  require('../../lib/app-settings').clearCache();
  let sawFormat = null;
  fetchHandler = async (_url, opts) => { sawFormat = JSON.parse(opts.body).response_format; return new Response(Buffer.from([1]), { status: 200 }); };
  const r = await postSpeak({ text: 'Format.' });
  assert.equal(r.status, 200);
  assert.equal(sawFormat, 'mp3');
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
});

'use strict';
// Range-Auslieferung der Interview-Aufnahme: `getAudioRange` liest per SQL-
// `substr` nur den Ausschnitt — Bytes und Offsets muessen exakt dem BLOB
// entsprechen (substr ist 1-basiert, die Route rechnet 0-basiert).
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('./_helpers/setup');

let ctx, db, ia;
const BOOK = 8901, U = 'autor@test.dev';

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  ia = require('../../db/interview');
  db.prepare(`INSERT INTO app_users (email, global_role, created_at) VALUES (?, 'user', '2026-01-01T00:00:00.000Z') ON CONFLICT(email) DO NOTHING`).run(U);
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'B', '2026-01-01', '2026-01-01')").run(BOOK);
});
test.after(() => ctx.cleanup());

test('getAudioMeta/getAudioRange: Groesse ohne BLOB, Ausschnitt bytegenau', () => {
  const item = db.prepare("INSERT INTO research_items (book_id, user_email, kind, title) VALUES (?, ?, 'note', 'Gespraech')")
    .run(BOOK, U).lastInsertRowid;
  const buf = Buffer.alloc(5000);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
  ia.createTranscript(item, BOOK, { buffer: buf, mime: 'audio/mpeg', name: 'a.mp3' });

  const meta = ia.getAudioMeta(item);
  assert.equal(meta.size, 5000);
  assert.equal(meta.audio_mime, 'audio/mpeg');

  assert.deepEqual(ia.getAudioRange(item, 0, 10), buf.subarray(0, 10));
  assert.deepEqual(ia.getAudioRange(item, 4990, 10), buf.subarray(4990, 5000));
  assert.deepEqual(ia.getAudioRange(item, 1234, 777), buf.subarray(1234, 2011));

  ia.dropAudio(item);
  assert.equal(ia.getAudioMeta(item), null, 'ohne Aufnahme keine Meta');
});

'use strict';
// Migration 0367 + chatTemperature: die Chat-Temperatur gehört dem lokalen Provider.
// Ein gesetzter Alt-Key geht an beide Provider-Keys (ein dort gesetzter Wert gewinnt),
// der Alt-Key fällt weg.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { SQUASHED_SCHEMA } = require('../../db/squashed-schema');
const migration = require('../../db/migrations/0367-chat-temperature-per-provider');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SQUASHED_SCHEMA);
  return db;
}
const put = (db, key, v) => db.prepare(
  `INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, '2026-11-01T00:00:00.000Z', 'admin@x')`
).run(key, JSON.stringify(v));
const val = (db, key) => {
  const r = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key);
  return r ? JSON.parse(r.value_json) : undefined;
};

test('Altwert geht an beide Provider-Keys, Alt-Key fällt weg', () => {
  const db = freshDb();
  put(db, 'ai.chat_temperature', 0.4);
  migration.up(db);
  assert.equal(val(db, 'ai.ollama.chat_temperature'), 0.4);
  assert.equal(val(db, 'ai.openai-compat.chat_temperature'), 0.4);
  assert.equal(val(db, 'ai.chat_temperature'), undefined);
});

test('gesetzter Provider-Key gewinnt gegen den Altwert', () => {
  const db = freshDb();
  put(db, 'ai.chat_temperature', 0.4);
  put(db, 'ai.ollama.chat_temperature', 0.9);
  migration.up(db);
  assert.equal(val(db, 'ai.ollama.chat_temperature'), 0.9);
  assert.equal(val(db, 'ai.openai-compat.chat_temperature'), 0.4);
});

test('ohne Altwert legt die Migration nichts an', () => {
  const db = freshDb();
  migration.up(db);
  assert.equal(val(db, 'ai.ollama.chat_temperature'), undefined);
  assert.equal(val(db, 'ai.openai-compat.chat_temperature'), undefined);
});

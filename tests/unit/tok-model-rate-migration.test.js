'use strict';
// Migration 0374: tok = ROUND(chars / Anzeige-Rate) mit derselben Regel wie
// lib/ai/config.js#CHARS_PER_TOKEN (Claude-Instanz: Rate des globalen Modells).
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const mig = require('../../db/migrations/0374-tok-model-rate');

function freshDb(settings) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE page_stats (page_id INTEGER PRIMARY KEY, chars INTEGER, tok INTEGER);
    CREATE TABLE book_stats_history (id INTEGER PRIMARY KEY, chars INTEGER, tok INTEGER);
    CREATE TABLE page_revisions (id INTEGER PRIMARY KEY, chars INTEGER, tok INTEGER);
  `);
  for (const [k, v] of Object.entries(settings)) {
    db.prepare('INSERT INTO app_settings (key, value_json) VALUES (?, ?)').run(k, JSON.stringify(v));
  }
  for (const t of ['page_stats', 'book_stats_history', 'page_revisions']) {
    db.prepare(`INSERT INTO ${t} (chars, tok) VALUES (2100, 700), (NULL, 5)`).run();
  }
  return db;
}
const toks = (db, t) => db.prepare(`SELECT tok FROM ${t} ORDER BY rowid`).all().map(r => r.tok);

test('Claude-Instanz mit Opus 5.5 → Rate 2.1 in allen drei Tabellen', () => {
  const db = freshDb({ 'ai.provider': 'claude', 'ai.claude.model': 'claude-opus-5-5' });
  mig.up(db);
  for (const t of ['page_stats', 'book_stats_history', 'page_revisions']) assert.deepEqual(toks(db, t), [1000, 5], t);
});

test('ohne Settings: Registry-Defaults (claude + claude-sonnet-5-5 → 2.1)', () => {
  const db = freshDb({});
  mig.up(db);
  assert.deepEqual(toks(db, 'page_stats'), [1000, 5]);
});

test('Claude 4.6 bleibt bei 3, lokaler Provider bei 4, expliziter Wert gilt', () => {
  let db = freshDb({ 'ai.provider': 'claude', 'ai.claude.model': 'claude-sonnet-4-6' });
  mig.up(db); assert.deepEqual(toks(db, 'page_stats'), [700, 5]);
  db = freshDb({ 'ai.provider': 'openai-compat', 'ai.claude.model': 'claude-opus-5-5' });
  mig.up(db); assert.deepEqual(toks(db, 'page_stats'), [525, 5]);
  db = freshDb({ 'ai.provider': 'ollama', 'ai.chars_per_token': 3.5 });
  mig.up(db); assert.deepEqual(toks(db, 'page_stats'), [600, 5]);
});

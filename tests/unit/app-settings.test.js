'use strict';
// app_settings + Helper-API.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('app-settings');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';

require('../../db/migrations');
const { db } = require('../../db/connection');
const settings = require('../../lib/app-settings');

test('schema_version >= 108', () => {
  const v = db.prepare('SELECT version FROM schema_version').get().version;
  assert.ok(v >= 108);
});

test('app_settings + app_settings_audit existieren', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('app_settings'));
  assert.ok(tables.includes('app_settings_audit'));
});

test('DEFAULTS greift fuer nicht gesetzte Keys', () => {
  assert.equal(settings.get('ai.provider'), 'claude');
  assert.equal(settings.get('app.timezone'), 'Europe/Zurich');
  assert.equal(settings.get('jobs.max_concurrent'), 1);
});

test('Unbekannter Key liefert undefined', () => {
  assert.equal(settings.get('does.not.exist'), undefined);
});

test('set + get Roundtrip (non-encrypted)', () => {
  settings.set('ai.provider', 'ollama', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.provider'), 'ollama');
});

test('set + get Roundtrip mit Default ueberschrieben', () => {
  settings.set('jobs.max_concurrent', 4, { updatedBy: 'tester@x' });
  assert.equal(settings.get('jobs.max_concurrent'), 4);
  // Wieder loeschen → Default kommt zurueck
  settings.remove('jobs.max_concurrent');
  assert.equal(settings.get('jobs.max_concurrent'), 1);
});

test('Encrypted Keys werden in DB verschluesselt persistiert', () => {
  settings.set('ai.claude.api_key', 'sk-ant-secret-value', { updatedBy: 'tester@x' });
  const row = db.prepare("SELECT value_json, encrypted FROM app_settings WHERE key = 'ai.claude.api_key'").get();
  assert.equal(row.encrypted, 1);
  assert.match(row.value_json, /^enc:v1:/);
  // Lesen entschluesselt transparent
  assert.equal(settings.get('ai.claude.api_key'), 'sk-ant-secret-value');
});

test('Encrypted-Sentinel __unchanged__: kein Update', () => {
  settings.set('ai.claude.api_key', 'sk-ant-original', { updatedBy: 'tester@x' });
  settings.set('ai.claude.api_key', '__unchanged__', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.claude.api_key'), 'sk-ant-original');
});

test('changed-Event feuert bei set', () => {
  let captured = null;
  const fn = ev => { captured = ev; };
  settings.on('changed', fn);
  settings.set('app.timezone', 'UTC', { updatedBy: 'tester@x' });
  assert.equal(captured?.key, 'app.timezone');
  assert.equal(captured?.updatedBy, 'tester@x');
  settings.off('changed', fn);
});

test('listForAdmin maskiert encrypted Werte', () => {
  settings.set('ai.claude.api_key', 'sk-ant-fullkey-1234', { updatedBy: 'tester@x' });
  const list = settings.listForAdmin();
  const apiKey = list.find(s => s.key === 'ai.claude.api_key');
  assert.ok(apiKey);
  assert.equal(apiKey.value, '__masked__');
  assert.match(apiKey.masked, /\*\*\*1234$/);
  assert.equal(apiKey.encrypted, 1);
});

test('listForAdmin enthaelt auch Default-Keys ohne DB-Row', () => {
  const list = settings.listForAdmin();
  const retryMax = list.find(s => s.key === 'ai.claude.retry_max');
  assert.ok(retryMax);
  assert.equal(retryMax.isDefault, true);
  assert.equal(retryMax.value, 3);
});

test('audit-Tabelle erhaelt Hashes bei jedem set', () => {
  const before = db.prepare("SELECT COUNT(*) AS c FROM app_settings_audit WHERE key = 'ai.provider'").get().c;
  settings.set('ai.provider', 'openai-compat', { updatedBy: 'audit-tester@x' });
  const after = db.prepare("SELECT COUNT(*) AS c FROM app_settings_audit WHERE key = 'ai.provider'").get().c;
  assert.ok(after > before, 'audit-Eintrag fehlt');
  const row = db.prepare("SELECT new_hash, updated_by FROM app_settings_audit WHERE key = 'ai.provider' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row.new_hash);
  assert.equal(row.updated_by, 'audit-tester@x');
});

test('isEncryptedKey: bekannte Keys werden erkannt', () => {
  assert.equal(settings.isEncryptedKey('ai.claude.api_key'), true);
  assert.equal(settings.isEncryptedKey('smtp.gmail.app_password'), true);
  assert.equal(settings.isEncryptedKey('ai.provider'), false);
});

test('bootstrapFromEnv: spiegelt nicht-gesetzte Keys aus ENV', () => {
  // Setze ENV-Werte → Bootstrap soll sie in DB schreiben
  process.env.OLLAMA_HOST = 'http://test-ollama:11434';
  process.env.CLAUDE_RETRY_MAX = '7';
  // Sicherstellen: Keys aktuell nicht in DB
  settings.remove('ai.ollama.host');
  settings.remove('ai.claude.retry_max');
  const mirrored = settings.bootstrapFromEnv();
  assert.ok(mirrored >= 2, `erwartet >=2 gespiegelt, got ${mirrored}`);
  assert.equal(settings.get('ai.ollama.host'), 'http://test-ollama:11434');
  assert.equal(settings.get('ai.claude.retry_max'), 7);
});

test('bootstrapFromEnv: ueberschreibt bestehende DB-Werte NICHT', () => {
  settings.set('ai.ollama.host', 'http://manual-set:11434', { updatedBy: 'admin' });
  process.env.OLLAMA_HOST = 'http://env-different:11434';
  settings.bootstrapFromEnv();
  assert.equal(settings.get('ai.ollama.host'), 'http://manual-set:11434');
});

test('bootstrapFromEnv: ungesetzte ENV → kein Eintrag', () => {
  delete process.env.NONEXISTENT_TEST_VAR;
  settings.remove('jobs.book_chat.token_budget');
  delete process.env.BOOK_CHAT_TOKEN_BUDGET;
  settings.bootstrapFromEnv();
  // Default greift
  assert.equal(settings.get('jobs.book_chat.token_budget'), 0);
  // Aber DB-Row darf nicht gesetzt sein
  assert.equal(settings.has('jobs.book_chat.token_budget'), false);
});

test('VALIDATORS: int-Range rejectet negative Werte', () => {
  assert.throws(
    () => settings.set('app.page_revision_limit', -1, { updatedBy: 'tester@x' }),
    err => err.code === 'INVALID_VALUE' && err.key === 'app.page_revision_limit',
  );
  // Wert wurde nicht persistiert
  assert.equal(settings.has('app.page_revision_limit'), false);
});

test('VALIDATORS: int-Range rejectet Werte ueber max', () => {
  assert.throws(
    () => settings.set('jobs.max_concurrent', 999, { updatedBy: 'tester@x' }),
    err => err.code === 'INVALID_VALUE',
  );
});

test('VALIDATORS: int-Range rejectet Floats', () => {
  assert.throws(
    () => settings.set('ai.claude.retry_max', 1.5, { updatedBy: 'tester@x' }),
    err => err.code === 'INVALID_VALUE',
  );
});

test('VALIDATORS: number-Range akzeptiert Floats im Bereich', () => {
  settings.set('ai.claude.api_key', 'sk-keep', { updatedBy: 'tester@x' }); // unrelated state
  settings.set('ai.ollama.chat_temperature', 0.5, { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.ollama.chat_temperature'), 0.5);
});

test('VALIDATORS: number-Range rejectet ausserhalb', () => {
  assert.throws(
    () => settings.set('ai.ollama.chat_temperature', 5, { updatedBy: 'tester@x' }),
    err => err.code === 'INVALID_VALUE',
  );
});

test('VALIDATORS: enum akzeptiert oneOf-Wert', () => {
  settings.set('ai.provider', 'claude', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.provider'), 'claude');
});

test('VALIDATORS: enum rejectet fremden Wert', () => {
  assert.throws(
    () => settings.set('ai.provider', 'openai', { updatedBy: 'tester@x' }),
    err => err.code === 'INVALID_VALUE',
  );
});

test('VALIDATORS: nicht-validierte Keys passieren ungehindert', () => {
  settings.set('app.timezone', 'Europe/Berlin', { updatedBy: 'tester@x' });
  assert.equal(settings.get('app.timezone'), 'Europe/Berlin');
});

test('VALIDATORS: __unchanged__-Sentinel bei encrypted ueberspringt Validation', () => {
  settings.set('ai.claude.api_key', 'sk-original', { updatedBy: 'tester@x' });
  // __unchanged__ ist kein gueltiger Wert irgendeines Validators, muss aber durch
  settings.set('ai.claude.api_key', '__unchanged__', { updatedBy: 'tester@x' });
  assert.equal(settings.get('ai.claude.api_key'), 'sk-original');
});

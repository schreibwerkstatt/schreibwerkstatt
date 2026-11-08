// Datei-Migrationen (db/migration-runner.js): Namens-/Versions-Validierung,
// Transaktion inkl. schema_version-Bump, foreign_keys OFF/ON ausserhalb der
// Transaktion, und die echte Migration 292 (user_email-Indexe) im Schema.
//
// Lauf: `node --test tests/unit/migration-runner.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('migration-runner-test');
require('../../db/migrations');
const { db } = require('../../db/connection');
const { loadFileMigrations, runFileMigrations } = require('../../db/migration-runner');
const Database = require('better-sqlite3');

function tmpDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-files-'));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  return dir;
}

function memDb(version) {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE schema_version (version INTEGER); CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id));');
  d.prepare('INSERT INTO schema_version VALUES (?)').run(version);
  d.pragma('foreign_keys = ON');
  return d;
}

test('Migration 292: user_email-Indexe existieren', () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  for (const n of ['idx_book_presence_user_email', 'idx_page_presence_user_email', 'idx_figure_age_scans_user_email', 'idx_chapter_extract_cache_user_email']) {
    assert.ok(names.has(n), n);
  }
  assert.ok(db.prepare('SELECT version FROM schema_version').get().version >= 292);
});

test('Validierung: Dateiname vs. version, Luecke, fehlendes up', () => {
  assert.throws(() => loadFileMigrations(tmpDir({ '0011-x.js': 'module.exports={version:12,up(){}}' }), 10), /exportiert version=12/);
  assert.throws(() => loadFileMigrations(tmpDir({ '0012-x.js': 'module.exports={version:12,up(){}}' }), 10), /erwartet Version 11/);
  assert.throws(() => loadFileMigrations(tmpDir({ '0011-x.js': 'module.exports={version:11}' }), 10), /up\(db\) fehlt/);
  assert.throws(() => loadFileMigrations(tmpDir({ '11-X.js': 'module.exports={version:11,up(){}}' }), 10), /NNNN-name/);
});

test('Lauf: nur offene Versionen, Bump pro Migration', () => {
  const dir = tmpDir({
    '0011-a.js': "module.exports={version:11,up(db){db.exec('CREATE TABLE a (x)')}}",
    '0012-b.js': "module.exports={version:12,up(db){db.exec('CREATE TABLE b (x)')}}",
  });
  const d = memDb(11); // 11 schon gelaufen
  runFileMigrations(d, loadFileMigrations(dir, 10));
  assert.equal(d.prepare('SELECT version FROM schema_version').get().version, 12);
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('b'));
  assert.ok(!tables.includes('a'));
});

test('Fehler in up bzw. FK-Verstoss rollt komplett zurueck, fkOff schaltet FKs wieder ein', () => {
  const dir = tmpDir({
    '0011-bad.js': "module.exports={version:11,fkOff:true,up(db){db.exec('CREATE TABLE z (x)'); db.exec('INSERT INTO c (id,p_id) VALUES (1,999)')}}",
  });
  const d = memDb(10);
  assert.throws(() => runFileMigrations(d, loadFileMigrations(dir, 10)), /foreign_key_check meldet 1/);
  assert.equal(d.prepare('SELECT version FROM schema_version').get().version, 10);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='z'").get().n, 0);
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
});

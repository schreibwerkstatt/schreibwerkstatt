'use strict';
// Regression-Sentinel: PRAGMA-Tuning in db/connection.js. Schützt vor
// versehentlichem Entfernen der Performance-PRAGMAs bei künftigen Refactors.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('pragma');
// Dieser Sentinel prüft die PRODUKTIONS-PRAGMAs. Den Test-Fast-Path (DB_FSYNC=off,
// gesetzt in den npm-Test-Scripts) hier ausschalten, damit synchronous=NORMAL greift.
delete process.env.DB_FSYNC;

const { db } = require('../../db/connection');

test('PRAGMA journal_mode = WAL', () => {
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
});

test('PRAGMA synchronous = NORMAL', () => {
  assert.equal(db.pragma('synchronous', { simple: true }), 1);
});

test('PRAGMA foreign_keys = ON', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('PRAGMA cache_size = -65536 (64 MB Page-Cache)', () => {
  assert.equal(db.pragma('cache_size', { simple: true }), -65536);
});

test('PRAGMA mmap_size = 256 MB', () => {
  assert.equal(db.pragma('mmap_size', { simple: true }), 268435456);
});

test('PRAGMA temp_store = MEMORY (2)', () => {
  assert.equal(db.pragma('temp_store', { simple: true }), 2);
});

test('PRAGMA busy_timeout = 5000 ms', () => {
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
});

test('PRAGMA wal_autocheckpoint = 1000 Frames', () => {
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000);
});

test('PRAGMA optimize: läuft fehlerfrei (Shutdown-Hook)', () => {
  assert.doesNotThrow(() => db.pragma('optimize'));
});

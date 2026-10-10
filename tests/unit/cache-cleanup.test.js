'use strict';
// Unit-Tests fuer lib/cache-cleanup.js. Seedet eine in-Tmp-Datei liegende DB
// mit alten und frischen Rows in einer Auswahl der Policy-Tabellen und
// verifiziert, dass nur die alten Rows entfernt werden.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('cache-cleanup');

const { db } = require('../../db/connection');

// Minimal-Schema fuer die getesteten Tabellen. Spalten-Namen matchen das
// echte Schema (siehe db/migrations.js); FK-Constraints werden hier
// bewusst weggelassen, weil wir nicht die volle Migrationspipeline ziehen.
const SCHEMA_STMTS = [
  `CREATE TABLE chapter_extract_cache (
    book_id INTEGER, user_email TEXT, chapter_id INTEGER, phase TEXT,
    pages_sig TEXT, extract_json TEXT, cached_at TEXT,
    PRIMARY KEY (book_id, user_email, chapter_id, phase)
  )`,
  `CREATE TABLE synonym_cache (
    user_email TEXT, key_hash TEXT, result_json TEXT, cached_at TEXT,
    PRIMARY KEY (user_email, key_hash)
  )`,
  `CREATE TABLE lektorat_cache (
    book_id INTEGER, user_email TEXT, page_id INTEGER,
    ctx_sig TEXT, result_json TEXT, cached_at TEXT,
    PRIMARY KEY (book_id, user_email, page_id)
  )`,
  `CREATE TABLE font_cache (
    family TEXT, weight INTEGER, style TEXT, ttf BLOB, fetched_at INTEGER,
    PRIMARY KEY (family, weight, style)
  )`,
  `CREATE TABLE job_runs (
    job_id TEXT PRIMARY KEY, type TEXT, status TEXT,
    queued_at TEXT, started_at TEXT, ended_at TEXT
  )`,
  `CREATE TABLE page_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER, checked_at TEXT
  )`,
  `CREATE TABLE book_stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER, recorded_at TEXT
  )`,
];
for (const stmt of SCHEMA_STMTS) db.prepare(stmt).run();

// Stale-Werte (200 Tage alt → trifft alle ISO-Policies ≤ 365 Tagen).
const STALE = "datetime('now', '-200 days')";
const STALE_EPOCH = Math.floor(Date.now() / 1000) - 200 * 86400;
// Frisch (gestern → unter jeder TTL).
const FRESH = "datetime('now', '-1 days')";
const FRESH_EPOCH = Math.floor(Date.now() / 1000) - 86400;

const SEED_STMTS = [
  `INSERT INTO chapter_extract_cache VALUES (1,'a@b',10,'p1','sig1','{}', ${STALE})`,
  `INSERT INTO chapter_extract_cache VALUES (1,'a@b',11,'p1','sig2','{}', ${FRESH})`,

  `INSERT INTO synonym_cache VALUES ('a@b','hash1','{}', ${STALE})`,
  `INSERT INTO synonym_cache VALUES ('a@b','hash2','{}', ${FRESH})`,

  `INSERT INTO lektorat_cache VALUES (1,'a@b',100,'sig','{}', ${STALE})`,
  `INSERT INTO lektorat_cache VALUES (1,'a@b',101,'sig','{}', ${FRESH})`,

  `INSERT INTO font_cache VALUES ('Lato',400,'normal', X'00', ${STALE_EPOCH})`,
  `INSERT INTO font_cache VALUES ('Lato',700,'normal', X'00', ${FRESH_EPOCH})`,

  `INSERT INTO job_runs VALUES ('old-done','x','done', ${STALE}, NULL, NULL)`,
  `INSERT INTO job_runs VALUES ('old-queued','x','queued', ${STALE}, NULL, NULL)`,
  `INSERT INTO job_runs VALUES ('fresh-done','x','done', ${FRESH}, NULL, NULL)`,
  // Chat-Job-Typen: 365 Tage statt 30 (Fehlerquote der Chats, db/chat-quality.js).
  `INSERT INTO job_runs VALUES ('old-chat-error','book-chat','error', ${STALE}, NULL, NULL)`,
  `INSERT INTO job_runs VALUES ('ancient-chat-error','chat','error', datetime('now','-400 days'), NULL, NULL)`,

  `INSERT INTO page_checks (page_id, checked_at) VALUES (1, ${STALE})`,
  `INSERT INTO page_checks (page_id, checked_at) VALUES (2, ${FRESH})`,

  `INSERT INTO book_stats_history (book_id, recorded_at) VALUES (1, ${FRESH})`,
];
// book_stats_history: Ausduennung statt TTL. Feste Monate weit vor der
// 365-Tage-Grenze (2020), damit der Test nicht vom heutigen Datum abhaengt:
// Buch 1 hat drei Tage im Januar + einen im Februar, Buch 2 zwei Tage im Januar.
// Erwartet: je (Buch, Monat) bleibt nur der letzte Snapshot.
const THIN_ROWS = [
  [1, '2020-01-03'], [1, '2020-01-17'], [1, '2020-01-31'],
  [1, '2020-02-10'],
  [2, '2020-01-05'], [2, '2020-01-20'],
];
for (const [bid, d] of THIN_ROWS) {
  SEED_STMTS.push(`INSERT INTO book_stats_history (book_id, recorded_at) VALUES (${bid}, '${d}')`);
}
// Juenger als 365 Tage: taeglich erhalten, auch mehrere im selben Monat.
SEED_STMTS.push(`INSERT INTO book_stats_history (book_id, recorded_at) VALUES (1, date('now','-30 days'))`);
SEED_STMTS.push(`INSERT INTO book_stats_history (book_id, recorded_at) VALUES (1, date('now','-31 days'))`);
for (const stmt of SEED_STMTS) db.prepare(stmt).run();

const { runCacheCleanup, POLICIES } = require('../../lib/cache-cleanup');

const summary = runCacheCleanup();

test('POLICIES enthaelt alle erwarteten Tabellen', () => {
  const names = POLICIES.map(p => p.table);
  assert.ok(names.includes('chapter_extract_cache'));
  assert.ok(names.includes('synonym_cache'));
  assert.ok(names.includes('lektorat_cache'));
  assert.ok(names.includes('font_cache'));
  assert.ok(names.includes('job_runs'));
  // page_checks (Lektorat-History) wird bewusst NICHT geprunt.
  assert.ok(!names.includes('page_checks'));
  assert.ok(names.includes('book_stats_history'));
});

test('chapter_extract_cache: nur stale Row weg', () => {
  const rows = db.prepare('SELECT chapter_id FROM chapter_extract_cache ORDER BY chapter_id').all();
  assert.deepEqual(rows.map(r => r.chapter_id), [11]);
});

test('synonym_cache: nur stale Row weg', () => {
  const rows = db.prepare('SELECT key_hash FROM synonym_cache ORDER BY key_hash').all();
  assert.deepEqual(rows.map(r => r.key_hash), ['hash2']);
});

test('lektorat_cache: nur stale Row weg (TTL 60 Tage)', () => {
  const rows = db.prepare('SELECT page_id FROM lektorat_cache ORDER BY page_id').all();
  assert.deepEqual(rows.map(r => r.page_id), [101]);
});

test('font_cache: epoch-TTL kickt stale Row', () => {
  const rows = db.prepare('SELECT weight FROM font_cache ORDER BY weight').all();
  assert.deepEqual(rows.map(r => r.weight), [700]);
});

test('job_runs: stale queued bleibt (status-Filter), stale done weg', () => {
  const rows = db.prepare('SELECT job_id FROM job_runs ORDER BY job_id').all();
  const ids = rows.map(r => r.job_id);
  assert.ok(ids.includes('fresh-done'));
  assert.ok(ids.includes('old-queued'));
  assert.ok(!ids.includes('old-done'));
});

test('job_runs: Chat-Typen bleiben 365 Tage (200 Tage alt bleibt, 400 Tage alt weg)', () => {
  const ids = db.prepare('SELECT job_id FROM job_runs').all().map(r => r.job_id);
  assert.ok(ids.includes('old-chat-error'));
  assert.ok(!ids.includes('ancient-chat-error'));
});

test('page_checks: bleibt vollstaendig erhalten (nicht geprunt)', () => {
  const rows = db.prepare('SELECT page_id FROM page_checks ORDER BY page_id').all();
  assert.deepEqual(rows.map(r => r.page_id), [1, 2]);
});

test('book_stats_history: aelter als 365 Tage → je Buch und Monat nur der letzte Snapshot', () => {
  const old = db.prepare(`SELECT book_id, recorded_at FROM book_stats_history
                           WHERE recorded_at < '2021-01-01' ORDER BY book_id, recorded_at`).all();
  assert.deepEqual(old.map(r => [r.book_id, r.recorded_at]), [
    [1, '2020-01-31'], [1, '2020-02-10'], [2, '2020-01-20'],
  ]);
});

test('book_stats_history: juengste 365 Tage bleiben taeglich', () => {
  const recent = db.prepare(`SELECT COUNT(*) AS c FROM book_stats_history
                              WHERE recorded_at >= date('now','-365 days')`).get().c;
  assert.equal(recent, 3, 'FRESH + die zwei Tage vor ~einem Monat');
  const entry = summary.tables.find(t => t.table === 'book_stats_history');
  assert.equal(entry.kind, 'thin-monthly');
  assert.equal(entry.removed, 3);
});

test('summary.totalRemoved >= 6 (eine pro getesteter Tabelle, page_checks ausgenommen)', () => {
  assert.ok(summary.totalRemoved >= 6, `erwartet >=6 entfernte Rows, got ${summary.totalRemoved}`);
});

test('Tabellen, die nicht im Test-Schema sind, werden uebersprungen', () => {
  const skipped = summary.tables.filter(t => t.skipped === 'table-missing');
  // book_extract_cache, chapter_review_cache, book_review_cache,
  // chapter_macro_review_cache, finetune_ai_cache sind im Test-Schema nicht angelegt.
  assert.ok(skipped.length >= 5, `erwartet >=5 uebersprungene Tabellen, got ${skipped.length}`);
});

test('Re-Run ist idempotent (kein Throw)', () => {
  const second = runCacheCleanup();
  assert.equal(second.totalRemoved, 0);
});

test('Vacuum-Flag laeuft fehlerfrei', () => {
  assert.doesNotThrow(() => runCacheCleanup({ vacuum: true }));
});

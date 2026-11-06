'use strict';
// /history/page-ages/:book_id ist cross-user: Co-Editoren eines Buchs sehen
// denselben Lektoratsstatus pro Seite. Der jüngste page_check (egal welcher
// User) gewinnt; `by` enthält die User-Mail. Findings/History bleiben weiterhin
// user-spezifisch — hier wird nur die Status-Aggregation getestet.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('page-ages-cross');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');

// Selbe Query wie in routes/history.js#/page-ages/:book_id — Drift-Schutz.
function pageAgesQuery(bookId) {
  const rows = db.prepare(`
    WITH latest AS (
      SELECT page_id, checked_at, saved_at, error_count, user_email,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC, id DESC) AS rn
      FROM page_checks
      WHERE book_id = ?
    )
    SELECT page_id,
           CASE WHEN saved_at IS NOT NULL AND saved_at > checked_at THEN saved_at ELSE checked_at END AS at,
           CASE WHEN saved_at IS NULL AND error_count > 0 THEN 1 ELSE 0 END AS pending,
           user_email AS by_email
    FROM latest
    WHERE rn = 1
  `).all(bookId);
  const map = {};
  for (const r of rows) map[r.page_id] = { at: r.at, pending: !!r.pending, by: r.by_email || null };
  return map;
}

test('cross-user: jüngster page_check pro Seite gewinnt, by enthält den Editor', () => {
  appUsers.createUser({ email: 'alice@co.ch', displayName: 'Alice' });
  appUsers.createUser({ email: 'bob@co.ch',   displayName: 'Bob' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(2001, 'Co-Buch', now, now, 'alice@co.ch');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(3001, 2001, 'Seite 1', now);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(3002, 2001, 'Seite 2', now);

  // Alice prüft Seite 1 zuerst, Bob danach — Bob gewinnt.
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(3001, 2001, '2025-01-01T10:00:00.000Z', 2, '[]', 'alice@co.ch');
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(3001, 2001, '2025-01-02T10:00:00.000Z', 0, '[]', 'bob@co.ch');
  // Nur Alice hat Seite 2 geprüft.
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(3002, 2001, '2025-01-01T11:00:00.000Z', 1, '[]', 'alice@co.ch');

  const map = pageAgesQuery(2001);

  // Seite 1: Bob ist der jüngste Editor, kein pending (error_count=0).
  assert.equal(map[3001].by, 'bob@co.ch');
  assert.equal(map[3001].pending, false);
  assert.equal(map[3001].at, '2025-01-02T10:00:00.000Z');

  // Seite 2: nur Alice, error_count=1 + saved_at NULL → pending.
  assert.equal(map[3002].by, 'alice@co.ch');
  assert.equal(map[3002].pending, true);

  // Bob sieht denselben Status wie Alice (cross-user): genau zwei Seiten.
  assert.equal(Object.keys(map).length, 2);
});

test('cross-user coverage: COUNT(DISTINCT page_id) über alle User', () => {
  // Verwendet dieselbe DB wie der vorige Test (2 unique pages mit Checks).
  const { checked } = db.prepare(
    'SELECT COUNT(DISTINCT page_id) as checked FROM page_checks WHERE book_id = ?'
  ).get(2001);
  assert.equal(checked, 2);
});

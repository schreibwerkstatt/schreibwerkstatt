'use strict';
// Unit-Test für die Share-Reader-Lese-Statistik (db/share-links):
// Verweildauer + Gesamt-Lesetiefe (share_views, MAX-Merge, Token-Guard),
// Kapitel-Drop-off (share_view_sections + readDepthByToken) und Gesamt-Fazit
// (share_feedback UPSERT + Aggregate in den Owner-List-Queries).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('share-views-stats');

const { db } = require('../../db/connection');
const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const shareLinks = require('../../db/share-links');

function makeChapter(id, bookId, name, position) {
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, bookId, name, position, '2026-01-01T00:00:00.000Z');
}

test('recordShareView + setViewDuration/setViewMaxScroll: MAX-Merge + Token-Guard', () => {
  const owner = 'stats-owner@x.test';
  appUsers.createUser({ email: owner, displayName: 'Owner' });
  schema.upsertBookByName(801, 'Buch 801');
  const link = shareLinks.createShareLink({ kind: 'book', bookId: 801, ownerEmail: owner });

  const viewId = shareLinks.recordShareView(link.token, 'iphashA');
  assert.ok(viewId > 0);
  assert.equal(shareLinks.getShareLinkByToken(link.token).view_count, 1);

  // Dauer: grösserer Wert gewinnt, kleinerer wird ignoriert (MAX).
  assert.equal(shareLinks.setViewDuration(viewId, link.token, 5000), true);
  assert.equal(shareLinks.setViewDuration(viewId, link.token, 3000), true);
  const row1 = db.prepare('SELECT duration_ms, max_scroll_pct FROM share_views WHERE id = ?').get(viewId);
  assert.equal(row1.duration_ms, 5000);

  // Lesetiefe: ebenfalls MAX.
  shareLinks.setViewMaxScroll(viewId, link.token, 40);
  shareLinks.setViewMaxScroll(viewId, link.token, 70);
  shareLinks.setViewMaxScroll(viewId, link.token, 55);
  assert.equal(db.prepare('SELECT max_scroll_pct FROM share_views WHERE id = ?').get(viewId).max_scroll_pct, 70);

  // Fremder Token trifft die view_id nicht.
  assert.equal(shareLinks.setViewDuration(viewId, 'wrongtokenwrongtoken', 999999), false);
  assert.equal(db.prepare('SELECT duration_ms FROM share_views WHERE id = ?').get(viewId).duration_ms, 5000);
});

test('recordSectionDepths + readDepthByToken: Kapitel-Aggregation + FK-Guard', () => {
  const owner = 'depth-owner@x.test';
  appUsers.createUser({ email: owner, displayName: 'Owner' });
  schema.upsertBookByName(802, 'Buch 802');
  makeChapter(9001, 802, 'Kapitel 1', 0);
  makeChapter(9002, 802, 'Kapitel 2', 1);
  const link = shareLinks.createShareLink({ kind: 'book', bookId: 802, ownerEmail: owner });

  const v1 = shareLinks.recordShareView(link.token, 'ipA');
  const v2 = shareLinks.recordShareView(link.token, 'ipB');

  // v1 liest K1 ganz (100), K2 halb (50). Ein fremdes Kapitel (99999) wird per FK
  // verworfen, nicht gespeichert.
  shareLinks.recordSectionDepths(v1, link.token, [
    { chapterId: 9001, pct: 100 },
    { chapterId: 9002, pct: 50 },
    { chapterId: 99999, pct: 80 },
  ]);
  // v2 liest nur K1 (60), MAX-Merge bei erneutem Melden von v1/K2 (30 < 50 → bleibt 50).
  shareLinks.recordSectionDepths(v2, link.token, [{ chapterId: 9001, pct: 60 }]);
  shareLinks.recordSectionDepths(v1, link.token, [{ chapterId: 9002, pct: 30 }]);

  const depth = shareLinks.readDepthByToken(link.token);
  // Sortiert nach chapters.position: K1 dann K2.
  assert.equal(depth.length, 2);
  assert.equal(depth[0].chapter_id, 9001);
  assert.equal(depth[0].chapter_name, 'Kapitel 1');
  assert.equal(depth[0].avg_depth_pct, 80); // (100 + 60) / 2
  assert.equal(depth[0].reached_views, 2);
  assert.equal(depth[1].chapter_id, 9002);
  assert.equal(depth[1].avg_depth_pct, 50); // nur v1, MAX(50,30)
  assert.equal(depth[1].reached_views, 1);

  // Fremdes Kapitel wurde nicht persistiert.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM share_view_sections WHERE chapter_id = 99999').get().n, 0);

  // view_id eines fremden Tokens wird abgewiesen.
  assert.equal(shareLinks.recordSectionDepths(v1, 'nottherighttoken1', [{ chapterId: 9001, pct: 99 }]), false);
});

test('upsertFeedback: ein Fazit pro Leser (UPSERT) + Owner-Aggregate', () => {
  const owner = 'fb-owner@x.test';
  appUsers.createUser({ email: owner, displayName: 'Owner' });
  schema.upsertBookByName(803, 'Buch 803');
  const link = shareLinks.createShareLink({ kind: 'book', bookId: 803, ownerEmail: owner });

  shareLinks.upsertFeedback(link.token, { readerToken: 'rtAAAAAAAAAAAAAAA', readerName: 'Anna', rating: 4, body: 'Stark' });
  shareLinks.upsertFeedback(link.token, { readerToken: 'rtBBBBBBBBBBBBBBB', readerName: 'Bob', rating: 2, body: null });
  // Anna aktualisiert ihr Fazit → kein zweiter Eintrag.
  shareLinks.upsertFeedback(link.token, { readerToken: 'rtAAAAAAAAAAAAAAA', readerName: 'Anna', rating: 5, body: 'Noch besser' });

  const list = shareLinks.listFeedbackByToken(link.token);
  assert.equal(list.length, 2, 'zwei Leser, kein Duplikat');
  const anna = list.find(f => f.reader_name === 'Anna');
  assert.equal(anna.rating, 5);
  assert.equal(anna.body, 'Noch besser');

  // Prefill: eigenes Fazit dieses Lesers.
  assert.equal(shareLinks.getFeedbackByReader(link.token, 'rtAAAAAAAAAAAAAAA').rating, 5);
  assert.equal(shareLinks.getFeedbackByReader(link.token, 'unknownreadertoken1'), undefined);

  // Aggregate in der Owner-List-Query: avg_rating (5+2)/2 = 3.5, feedback_count 2.
  const rows = shareLinks.listSharesByOwner(owner).filter(r => r.token === link.token);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback_count, 2);
  assert.equal(rows[0].avg_rating, 3.5);
});

test('Owner-List-Query: avg_max_scroll_pct über mehrere Aufrufe', () => {
  const owner = 'scroll-owner@x.test';
  appUsers.createUser({ email: owner, displayName: 'Owner' });
  schema.upsertBookByName(804, 'Buch 804');
  const link = shareLinks.createShareLink({ kind: 'book', bookId: 804, ownerEmail: owner });
  const a = shareLinks.recordShareView(link.token, 'ipX');
  const b = shareLinks.recordShareView(link.token, 'ipY');
  shareLinks.setViewMaxScroll(a, link.token, 80);
  shareLinks.setViewMaxScroll(b, link.token, 40);

  const row = shareLinks.listSharesByOwner(owner).find(r => r.token === link.token);
  assert.equal(row.avg_max_scroll_pct, 60); // (80 + 40) / 2
});

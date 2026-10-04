// content-store movePage: Re-Parent einer Seite in ein anderes Buch unter
// Beibehaltung der page_id. Prueft, dass seiten-intrinsische Daten mitziehen
// (book_id nachgefuehrt), Buchwelt-Analyse der Quelle gekappt wird und die
// book_order-Overlays beider Buecher reconciled werden.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
const tmpDb = useTmpDb('move-page');

require('../../db/migrations');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');
const bookOrder = require('../../db/book-order');

const now = new Date().toISOString();
function seedBook(id, name) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, name, now, now);
}
function seedChapter(id, bookId, name, pos) {
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, bookId, name, pos, now);
}

test('movePage: Seite wandert ins Zielbuch, intrinsisch zieht mit, Buchwelt gekappt', async () => {
  const SRC = 7001, DST = 7002, SRC_CH = 8001;
  seedBook(SRC, 'Quelle');
  seedBook(DST, 'Ziel');
  seedChapter(SRC_CH, SRC, 'Kapitel 1', 0);

  // Seite in Quelle/Kapitel anlegen (ueber die Facade → echte page_id + book_order-Init).
  const page = await contentStore.createPage({ book_id: SRC, chapter_id: SRC_CH, name: 'Szene', html: '<p>Hallo</p>' });
  const pid = page.id;

  // Figur im Quellbuch + buchwelt-Analyse-Zeilen, die an die Seite haengen.
  const figRes = db.prepare(
    'INSERT INTO figures (book_id, fig_id, name, updated_at, erste_erwaehnung_page_id) VALUES (?, ?, ?, ?, ?)'
  ).run(SRC, 'fig-a', 'Anna', now, pid);
  const figId = figRes.lastInsertRowid;
  db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count) VALUES (?, ?, ?)').run(pid, figId, 3);
  db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, chapter_id, page_id) VALUES (?, ?, ?, ?, ?)')
    .run(figId, '2020', 'Auftritt', SRC_CH, pid);

  // Seiten-intrinsische Daten.
  db.prepare('INSERT INTO page_revisions (page_id, book_id, body_html, source) VALUES (?, ?, ?, ?)')
    .run(pid, SRC, '<p>Hallo</p>', 'main');
  db.prepare('INSERT INTO page_stats (page_id, book_id, chars, words, tok) VALUES (?, ?, ?, ?, ?)')
    .run(pid, SRC, 5, 1, 2);

  // book_order beider Buecher initialisieren (Quelle hat die Seite, Ziel ist leer).
  bookOrder.ensureTree(SRC);
  bookOrder.ensureTree(DST);
  assert.ok(JSON.stringify(bookOrder.getOrder(SRC).tree).includes(`"id":${pid}`), 'Quelle hat Seite vor Move');

  // ── Move ──────────────────────────────────────────────────────────────────
  const res = await contentStore.movePage(pid, { targetBookId: DST });
  assert.equal(res.ok, true);
  assert.equal(res.sourceBookId, SRC);
  assert.equal(res.targetBookId, DST);

  // Seite gehoert jetzt dem Zielbuch, top-level (kein Kapitel).
  const moved = db.prepare('SELECT book_id, chapter_id FROM pages WHERE page_id = ?').get(pid);
  assert.equal(moved.book_id, DST);
  assert.equal(moved.chapter_id, null);

  // Intrinsisch zieht mit (book_id nachgefuehrt).
  assert.equal(db.prepare('SELECT book_id FROM page_revisions WHERE page_id = ?').get(pid).book_id, DST);
  assert.equal(db.prepare('SELECT book_id FROM page_stats WHERE page_id = ?').get(pid).book_id, DST);

  // Buchwelt-Analyse der Quelle gekappt.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_figure_mentions WHERE page_id = ?').get(pid).n, 0);
  const evt = db.prepare('SELECT page_id, chapter_id FROM figure_events WHERE figure_id = ?').get(figId);
  assert.equal(evt.page_id, null);
  assert.equal(evt.chapter_id, null);
  assert.equal(db.prepare('SELECT erste_erwaehnung_page_id AS e FROM figures WHERE id = ?').get(figId).e, null);

  // book_order: Quelle ohne, Ziel mit der Seite.
  assert.ok(!JSON.stringify(bookOrder.getOrder(SRC).tree).includes(`"id":${pid}`), 'Quelle ohne Seite nach Move');
  assert.ok(JSON.stringify(bookOrder.getOrder(DST).tree).includes(`"id":${pid}`), 'Ziel hat Seite nach Move');
});

test('movePage: gleiches Buch wird abgelehnt', async () => {
  const B = 7101, CH = 8101;
  seedBook(B, 'Buch');
  seedChapter(CH, B, 'K', 0);
  const page = await contentStore.createPage({ book_id: B, chapter_id: CH, name: 'P', html: '<p>x</p>' });
  await assert.rejects(
    () => contentStore.movePage(page.id, { targetBookId: B }),
    (e) => e.code === 'SAME_BOOK',
  );
});

test('movePage: Zielkapitel muss zum Zielbuch gehoeren', async () => {
  const SRC = 7201, DST = 7202, FOREIGN_CH = 8201;
  seedBook(SRC, 'Q');
  seedBook(DST, 'Z');
  seedChapter(FOREIGN_CH, SRC, 'Fremdkapitel', 0); // liegt in SRC, nicht DST
  const page = await contentStore.createPage({ book_id: SRC, name: 'P', html: '<p>x</p>' });
  await assert.rejects(
    () => contentStore.movePage(page.id, { targetBookId: DST, targetChapterId: FOREIGN_CH }),
    (e) => e.code === 'CHAPTER_NOT_IN_TARGET',
  );
});

test('movePage: in ein Zielkapitel setzt chapter_id korrekt', async () => {
  const SRC = 7301, DST = 7302, DST_CH = 8301;
  seedBook(SRC, 'Q');
  seedBook(DST, 'Z');
  seedChapter(DST_CH, DST, 'Zielkapitel', 0);
  const page = await contentStore.createPage({ book_id: SRC, name: 'P', html: '<p>x</p>' });
  const res = await contentStore.movePage(page.id, { targetBookId: DST, targetChapterId: DST_CH });
  assert.equal(res.targetBookId, DST);
  const moved = db.prepare('SELECT book_id, chapter_id FROM pages WHERE page_id = ?').get(page.id);
  assert.equal(moved.book_id, DST);
  assert.equal(moved.chapter_id, DST_CH);
  assert.ok(JSON.stringify(bookOrder.getOrder(DST).tree).includes(`"id":${page.id}`));
});

'use strict';
// Bearbeitungsstand in der Share-Leseansicht (docs/bearbeitungsstand.md,
// docs/share-link.md): Buch-/Kapitel-Share zeigen je Abschnitt «Stand: …» unter
// der Ueberschrift, der Abschnitts-Share im Masthead. Nur Stufen der Buch-Kette;
// der Hinweis zaehlt nicht zum Umfang.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const tmp = path.join('/tmp', `share-edit-status-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const sl = require('../../db/share-links');
const redaktion = require('../../db/redaktion');
const H = require('../../lib/share-helpers');

const express = require('express');
const shareRouter = require('../../routes/share');

const OWNER = 'autor@status.test';
const BOOK_ID = 7301;
const CH_A = 7311;
const CH_B = 7312;
const PAGE_A = 7321; // eigene Ueberschrift, Stufe gesetzt
const PAGE_B = 7322; // ohne Stufe
const PAGE_C = 7323; // gleichnamig wie Kapitel B → Ueberschrift faellt weg
const PAGE_D = 7324; // Stufe der anderen Kette

function seed() {
  const now = new Date().toISOString();
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Autor' });
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(BOOK_ID, 'Stand-Buch', now, now);
  // Share-Links leben nur, solange ihr Ersteller die Buchrolle hat (isExpired).
  require('../../db/book-access').grantAccess(BOOK_ID, OWNER, 'owner', OWNER);
  const ch = db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)`);
  ch.run(CH_A, BOOK_ID, 'Kapitel Eins', 0, now);
  ch.run(CH_B, BOOK_ID, 'Kapitel Zwei', 1, now);
  const pg = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`);
  pg.run(PAGE_A, BOOK_ID, 'Abschnitt A', CH_A, 0, now, '<p>TEXT_A</p>');
  pg.run(PAGE_B, BOOK_ID, 'Abschnitt B', CH_A, 1, now, '<p>TEXT_B</p>');
  pg.run(PAGE_C, BOOK_ID, 'Kapitel Zwei', CH_B, 0, now, '<p>TEXT_C</p>');
  pg.run(PAGE_D, BOOK_ID, 'Abschnitt D', CH_B, 1, now, '<p>TEXT_D</p>');
  redaktion.setPageStatus(PAGE_A, BOOK_ID, { status: 'ueberarbeitet' });
  redaktion.setPageStatus(PAGE_C, BOOK_ID, { status: 'final' });
  redaktion.setPageStatus(PAGE_D, BOOK_ID, { status: 'gegengelesen' }); // Redaktions-Kette, Buch ist Roman
}

let server, baseUrl;
test.before(async () => {
  seed();
  const app = express();
  app.use('/share', shareRouter);
  await new Promise((res) => { server = app.listen(0, res); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server?.close(); });

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + pathname, { headers: { 'accept-language': 'de-CH' } }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
}

const statusBlocks = (html) => html.match(/<p class="share-status[^"]*">[^<]*<\/p>/g) || [];

test('Buch-Share: Stand je Abschnitt unter der Ueberschrift, nur Stufen der Buch-Kette', async () => {
  const link = sl.createShareLink({ kind: 'book', bookId: BOOK_ID, ownerEmail: OWNER });
  const { status, body } = await get(`/share/${link.token}`);
  assert.equal(status, 200);
  const blocks = statusBlocks(body);
  assert.equal(blocks.length, 2, `genau A und C tragen einen Stand: ${blocks.join(' | ')}`);
  assert.match(blocks[0], /share-status--r1">Stand: überarbeitet</);
  // C: Ueberschrift faellt weg (gleich wie Kapitel), der Stand bleibt.
  assert.match(blocks[1], /share-status--r3">Stand: final</);
  assert.ok(body.indexOf(blocks[0]) < body.indexOf('TEXT_A'), 'Stand steht vor dem Text');
  assert.ok(body.indexOf(blocks[1]) < body.indexOf('TEXT_C'));
  assert.doesNotMatch(body, /gegengelesen/, 'Stufe der anderen Kette erscheint nicht');
  // Ein Abschnitt ohne eigenen Titel-Kopf wird durch den Stand nicht zum Beitrag.
  assert.doesNotMatch(body, /--article/);
});

test('Abschnitts-Share: Stand im Masthead, nicht im Text', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_A, bookId: BOOK_ID, ownerEmail: OWNER });
  const { body } = await get(`/share/${link.token}`);
  assert.match(body, /<span class="share-header__meta-item">Stand: überarbeitet<\/span>/);
  assert.equal(statusBlocks(body).length, 0);
});

test('Umfang zaehlt den Stand nicht mit; TTS-Guard-Inhalt ohne Stand', async () => {
  const link = sl.getShareLinkByToken(sl.createShareLink({ kind: 'book', bookId: BOOK_ID, ownerEmail: OWNER }).token);
  const withStatus = await H.loadContentForLink(link, { lang: 'de' });
  const plain = await H.loadContentForLink(link);
  assert.equal(statusBlocks(plain.html).length, 0);
  assert.equal(H.htmlToPlainLength(withStatus.html), H.htmlToPlainLength(plain.html));
});

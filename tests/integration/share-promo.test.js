'use strict';
// App-Hinweis in der Share-Leseansicht (share_links.show_promo, Migration 370):
// Standard an → Footer «Dieses Manuskript entsteht mit …» + Link auf die Landing
// mit `?ref=share`, und der Reader-Config trägt den Kommentar-Hinweis mit
// `?ref=share-comment`. Abgeschaltet → kein Hinweis, kein Promo-Config, nur der
// schlichte App-Link im Footer.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const tmp = path.join('/tmp', `share-promo-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const sl = require('../../db/share-links');

const express = require('express');
const shareRouter = require('../../routes/share');

const OWNER = 'autor@promo.test';
const BOOK_ID = 7301;
const CHAPTER_ID = 7311;
const PAGE_ID = 7321;

function seed() {
  const now = new Date().toISOString();
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Autor Paul' });
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(BOOK_ID, 'Promo-Buch', now, now);
  require('../../db/book-access').grantAccess(BOOK_ID, OWNER, 'owner', OWNER);
  db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at)
              VALUES (?, ?, 'Kapitel', 0, ?)`).run(CHAPTER_ID, BOOK_ID, now);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (?, ?, 'Abschnitt', ?, 0, ?, '<p>PROMO_TEXT</p>')`).run(PAGE_ID, BOOK_ID, CHAPTER_ID, now);
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

function get(pathname, lang = 'de') {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + pathname, { headers: { 'Accept-Language': lang } }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
}

function readerConfig(html) {
  const m = html.match(/<script id="share-config" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'share-config fehlt');
  return JSON.parse(m[1]);
}

test('neuer Link: show_promo ist standardmässig an', () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  assert.strictEqual(link.show_promo, 1);
});

test('Promo an: Footer-Hinweis + Landing-Link mit ref=share, Kommentar-Hinweis im Config', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  const r = await get(`/share/${link.token}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /class="share-footer__promo">Dieses Manuskript entsteht mit Schreibwerkstatt</);
  assert.match(r.body, /href="\/\?ref=share"[^>]*>Selbst ausprobieren</);
  const cfg = readerConfig(r.body);
  assert.ok(cfg.promo, 'promo-Config muss gesetzt sein');
  assert.strictEqual(cfg.promo.url, '/?ref=share-comment');
  assert.match(cfg.promo.body, /Schreibwerkstatt lektoriert mit KI/);
  assert.match(r.body, /\/js\/share-reader\/promo\.js/);
});

test('Promo an (EN): Footer übersetzt', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  const r = await get(`/share/${link.token}`, 'en-US');
  assert.match(r.body, /This manuscript is being written with Schreibwerkstatt/);
  assert.match(r.body, />Try it yourself</);
});

test('Promo aus: kein Hinweis, kein promo-Config, schlichter App-Link bleibt', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER, showPromo: false });
  assert.strictEqual(link.show_promo, 0);
  const r = await get(`/share/${link.token}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /PROMO_TEXT/);
  assert.doesNotMatch(r.body, /share-footer__promo/);
  assert.doesNotMatch(r.body, /ref=share/);
  assert.strictEqual(readerConfig(r.body).promo, null);
  assert.match(r.body, /class="share-footer__link"[^>]*>Schreibwerkstatt</);
});

test('Promo per Update umschaltbar', async () => {
  const link = sl.createShareLink({ kind: 'page', pageId: PAGE_ID, bookId: BOOK_ID, ownerEmail: OWNER });
  assert.ok(sl.updateShareLink(link.token, OWNER, { showPromo: false }));
  assert.strictEqual(sl.getShareLinkByToken(link.token).show_promo, 0);
  let r = await get(`/share/${link.token}`);
  assert.doesNotMatch(r.body, /share-footer__promo/);
  assert.ok(sl.updateShareLink(link.token, OWNER, { showPromo: true }));
  r = await get(`/share/${link.token}`);
  assert.match(r.body, /share-footer__promo/);
});

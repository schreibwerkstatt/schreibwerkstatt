'use strict';
// SSR der allgemeinen Share-Kommentare (lib/share-comments-ssr.js): gleiches
// Karten-Markup + gleiche Reihenfolge wie die Client-Hydration
// (share-reader/thread-render.js), damit die Liste beim Laden nicht springt.

const test = require('node:test');
const assert = require('node:assert');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('share-comments-ssr');
require('../../db/migrations').runMigrations();

const { renderGeneralCommentsHtml } = require('../../lib/share-comments-ssr');

const ROWS = [
  { id: 1, parent_id: null, reader_name: 'Tom Beta', body: 'Später <b>', created_at: '2026-06-21 09:00:00' },
  { id: 2, parent_id: 1, author_email: 'owner@x.test', author_display_name: 'Owner', body: 'Antwort', created_at: '2026-06-21T10:00:00.000Z' },
  { id: 3, parent_id: null, reader_name: null, body: 'Früher', created_at: '2026-06-20T08:00:00.000Z', resolved_at: '2026-06-22T08:00:00.000Z' },
  { id: 4, parent_id: null, reader_name: 'Ankerin', body: 'verankert', created_at: '2026-06-19T08:00:00.000Z', anchor_bid: 'b1', anchor_quote: 'x' },
];

test('SSR: allgemeine Threads chronologisch im comment-rail-Markup, Verankerte fehlen', async () => {
  const html = await renderGeneralCommentsHtml(ROWS, 'de');
  const ids = [...html.matchAll(/data-comment-id="(\d+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, ['3', '1'], 'älteste zuerst, verankerter Thread nicht im SSR');
  assert.match(html, /class="comment-rail__thread share-thread comment-rail__thread--resolved"/);
  assert.match(html, /comment-rail__comment--reply comment-rail__comment--author/, 'Owner-Antwort unter ihrem Root');
  assert.doesNotMatch(html, /<b>/, 'Body escaped');
  assert.match(html, /Später &lt;b&gt;/);
});

test('SSR: Zeit als <time datetime> in Kurzform, SQLite-Format als UTC gelesen', async () => {
  const html = await renderGeneralCommentsHtml(ROWS, 'de');
  assert.match(html, /<time class="comment-rail__time" datetime="2026-06-21T09:00:00\.000Z" title="[^"]+">[^<]+<\/time>/);
  assert.doesNotMatch(html, />2026-06-21 09:00:00</, 'kein roher DB-Zeitstempel');
  assert.doesNotMatch(html, /:\d\d:\d\d</, 'keine Sekunden in der Kurzform');
});

test('SSR: Avatar-Pip mit Initialen + Hue, Autor-Label lokalisiert', async () => {
  const de = await renderGeneralCommentsHtml(ROWS, 'de');
  assert.match(de, /<span class="comment-rail__avatar" aria-hidden="true" style="--avatar-hue:\d+">TB<\/span>/);
  assert.match(de, /comment-rail__author">Autor</);
  const en = await renderGeneralCommentsHtml(ROWS, 'en');
  assert.match(en, /comment-rail__author">Author</);
});

test('SSR: ohne allgemeine Kommentare der Leer-Hinweis', async () => {
  const html = await renderGeneralCommentsHtml([ROWS[3]], 'de');
  assert.match(html, /^<li class="share-comments__empty">/);
});

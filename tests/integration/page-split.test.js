'use strict';
// POST /content/pages/:id/split — Abschnitt teilen (Notebook-Editor).
// Verifiziert an den echten Routern unter Express:
//   - Kopf bleibt auf der Seite, Schwanz wird neue Seite DIREKT dahinter im
//     selben Kapitel (book_order + materialisierte Positionen),
//   - beide Haelften laufen durch den Sanitizer (Skript/on*-Attribute fallen),
//   - ganze Bloecke behalten ihre data-bid (Anker ziehen mit), eine in Kopf und
//     Schwanz doppelte data-bid bleibt nur im Kopf,
//   - Revisionen: Stand vor dem Teilen + Kopf auf der Ausgangsseite, Schwanz
//     auf der neuen Seite,
//   - nur im Schwanz referenzierte Bilder wandern zur neuen Seite,
//   - verankerte Kapitel-Share-Kommentare loesen auf die neue Seite auf,
//   - 409 bei veraltetem Stempel (nichts geschrieben), 400 bei leerer Haelfte /
//     fehlendem Namen, 403 ohne editor-Recht bzw. fuer ein fremdes Buch.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autorin@test.dev';

const ME = 'autorin@test.dev';
const VIEWER = 'leser@test.dev';
const OTHER = 'fremd@test.dev';
const BOOK = 9301;
const FOREIGN_BOOK = 9302;
const CHAPTER = 9311;
const FOREIGN_CHAPTER = 9312;
const PAGE_A = 93011;
const PAGE = 93012;
const PAGE_B = 93013;
const FOREIGN_PAGE = 93021;
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

const ORIGINAL = '<h2 data-bid="aaaa0001">Kapitelanfang</h2>'
  + '<p data-bid="aaaa0002">Erster Teil, erster Absatz.</p>'
  + '<p data-bid="aaaa0003">Hier wird geteilt mitten im Satz.</p>'
  + '<p data-bid="aaaa0004">Zweiter Teil.</p>';

test.beforeEach(() => {
  sessionUser = ME;
  for (const t of ['share_comments', 'share_links', 'page_revisions', 'page_images', 'book_access', 'book_order']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  const insUser = db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)');
  for (const e of [ME, VIEWER, OTHER]) insUser.run(e, NOW);
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insBook.run(BOOK, 'Roman', NOW, NOW);
  insBook.run(FOREIGN_BOOK, 'Fremd', NOW, NOW);
  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)');
  insChap.run(CHAPTER, BOOK, 'Kapitel 1', NOW);
  insChap.run(FOREIGN_CHAPTER, FOREIGN_BOOK, 'Fremdes Kapitel', NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insPage.run(PAGE_A, BOOK, 'Vorher', CHAPTER, 0, NOW, '<p>Davor.</p>');
  insPage.run(PAGE, BOOK, 'Langer Abschnitt', CHAPTER, 1, NOW, ORIGINAL);
  insPage.run(PAGE_B, BOOK, 'Nachher', CHAPTER, 2, NOW, '<p>Danach.</p>');
  insPage.run(FOREIGN_PAGE, FOREIGN_BOOK, 'Geheim', FOREIGN_CHAPTER, 0, NOW, '<p>Geheim.</p>');
  const { grantAccess } = require('../../db/book-access');
  grantAccess(BOOK, ME, 'editor', ME);
  grantAccess(BOOK, VIEWER, 'viewer', ME);
  grantAccess(FOREIGN_BOOK, OTHER, 'owner', OTHER);
});

// Kopf/Schwanz so, wie der Client sie liefert: Absatz aaaa0003 am Caret
// geteilt — beide Haelften tragen dieselbe data-bid.
const HEAD = '<h2 data-bid="aaaa0001">Kapitelanfang</h2>'
  + '<p data-bid="aaaa0002">Erster Teil, erster Absatz.</p>'
  + '<p data-bid="aaaa0003">Hier wird geteilt </p>';
const TAIL = '<p data-bid="aaaa0003">mitten im Satz.</p>'
  + '<p data-bid="aaaa0004" onclick="alert(1)">Zweiter Teil.</p><script>alert(2)</script>';

function chapterOrder() {
  const tree = require('../../db/book-order').getOrder(BOOK).tree;
  const ch = tree.find(n => n.type === 'chapter' && n.id === CHAPTER);
  return ch.children.filter(n => n.type === 'page').map(n => n.id);
}

test('Split: Kopf bleibt, Schwanz wird neue Seite direkt dahinter im selben Kapitel', async () => {
  // Kapitel-Share mit Kommentar am Block, der in den Schwanz wandert.
  db.prepare(`INSERT INTO share_links (token, kind, chapter_id, book_id, owner_email, created_at)
              VALUES ('tok-split', 'chapter', ?, ?, ?, ?)`).run(CHAPTER, BOOK, ME, NOW);
  db.prepare(`INSERT INTO share_comments (share_token, reader_name, body, anchor_bid, anchor_quote, created_at)
              VALUES ('tok-split', 'Leserin', 'Schoen!', 'aaaa0004', 'Zweiter Teil', ?)`).run(NOW);
  // Bild nur im Schwanz, eines in beiden Haelften.
  const { insertPageImage } = require('../../db/page-images');
  const imgTail = insertPageImage({ pageId: PAGE, mime: 'image/jpeg', image: Buffer.from('a') });
  const imgBoth = insertPageImage({ pageId: PAGE, mime: 'image/jpeg', image: Buffer.from('b') });
  const head = HEAD + `<figure><img src="/content/page-image/${imgBoth}" alt=""></figure>`;
  const tail = TAIL + `<figure><img src="/content/page-image/${imgTail}" alt=""></figure>`
    + `<figure><img src="/content/page-image/${imgBoth}" alt=""></figure>`;

  const r = await api('POST', `/content/pages/${PAGE}/split`, {
    head_html: head, tail_html: tail, new_name: 'Langer Abschnitt (2)', expected_updated_at: NOW,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { head: h, tail: t } = r.json;
  assert.equal(h.id, PAGE);
  assert.notEqual(t.id, PAGE);
  assert.equal(t.name, 'Langer Abschnitt (2)');
  assert.equal(t.chapter_id, CHAPTER);
  assert.equal(t.book_id, BOOK);

  // Inhalt + Sanitizer.
  assert.match(h.html, /Hier wird geteilt/);
  assert.doesNotMatch(h.html, /Zweiter Teil/);
  assert.match(t.html, /mitten im Satz/);
  assert.match(t.html, /Zweiter Teil/);
  assert.doesNotMatch(t.html, /<script|onclick/);
  assert.notEqual(h.updated_at, NOW, 'Kopf-Stempel rueckt vor');

  // Block-IDs: ganzer Block behaelt seine ID, geteilter Absatz nur im Kopf.
  assert.match(h.html, /data-bid="aaaa0003"/);
  assert.doesNotMatch(t.html, /data-bid="aaaa0003"/);
  assert.match(t.html, /data-bid="aaaa0004"/);
  const tailFirst = t.html.match(/<p data-bid="([^"]+)">mitten/);
  assert.ok(tailFirst && tailFirst[1], 'geteilte Absatzhaelfte bekommt frische ID');

  // Reihenfolge: A, P, neu, B — in book_order und materialisiert.
  assert.deepEqual(chapterOrder(), [PAGE_A, PAGE, t.id, PAGE_B]);
  const pos = Object.fromEntries(db.prepare('SELECT page_id, position FROM pages WHERE chapter_id = ?')
    .all(CHAPTER).map(x => [x.page_id, x.position]));
  assert.ok(pos[PAGE] < pos[t.id] && pos[t.id] < pos[PAGE_B], JSON.stringify(pos));

  // Revisionen: Stand vor dem Teilen + Kopf; neue Seite mit Schwanz.
  const revs = db.prepare('SELECT body_html, summary FROM page_revisions WHERE page_id = ? ORDER BY id').all(PAGE);
  assert.equal(revs.length, 2);
  assert.match(revs[0].body_html, /mitten im Satz/, 'ungeteilter Stand in der Geschichte');
  assert.equal(revs[0].summary, 'before split');
  assert.match(revs[1].summary, /^split → #/);
  const tailRevs = db.prepare('SELECT summary FROM page_revisions WHERE page_id = ?').all(t.id);
  assert.equal(tailRevs.length, 1);
  assert.equal(tailRevs[0].summary, `split from #${PAGE}`);

  // Bilder: nur im Schwanz → neue Seite; in beiden → bleibt.
  const owner = (id) => db.prepare('SELECT page_id FROM page_images WHERE id = ?').get(id).page_id;
  assert.equal(owner(imgTail), t.id);
  assert.equal(owner(imgBoth), PAGE);

  // Verankerter Kapitel-Share-Kommentar loest auf die neue Seite auf.
  const contentStore = require('../../lib/content-store');
  assert.equal(contentStore.findPagesByBlockIds(BOOK, ['aaaa0004']).aaaa0004, t.id);
  assert.equal(contentStore.findPagesByBlockIds(BOOK, ['aaaa0003']).aaaa0003, PAGE);

  // Baum (Facade) zeigt dieselbe Reihenfolge.
  const tree = await contentStore.bookTree(BOOK);
  assert.deepEqual(tree.chapters[0].pages.map(p => p.id), [PAGE_A, PAGE, t.id, PAGE_B]);
});

test('Split: veralteter Stempel → 409, nichts geschrieben', async () => {
  const r = await api('POST', `/content/pages/${PAGE}/split`, {
    head_html: HEAD, tail_html: TAIL, new_name: 'Teil 2', expected_updated_at: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'PAGE_CONFLICT');
  assert.equal(r.json.server_updated_at, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(BOOK).n, 3);
  assert.equal(db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(PAGE).body_html, ORIGINAL);
});

test('Split: leere Haelfte / fehlender Name → 400', async () => {
  const empty = await api('POST', `/content/pages/${PAGE}/split`, {
    head_html: HEAD, tail_html: '<p><br></p>', new_name: 'Teil 2',
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error_code, 'SPLIT_EMPTY_PART');
  const noName = await api('POST', `/content/pages/${PAGE}/split`, {
    head_html: HEAD, tail_html: TAIL, new_name: '   ',
  });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error_code, 'NAME_REQUIRED');
  const noHtml = await api('POST', `/content/pages/${PAGE}/split`, { head_html: HEAD, new_name: 'x' });
  assert.equal(noHtml.json.error_code, 'HTML_REQUIRED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(BOOK).n, 3);
});

test('Split: viewer und fremdes Buch → 403; unbekannte Seite → 404', async () => {
  sessionUser = VIEWER;
  const v = await api('POST', `/content/pages/${PAGE}/split`, { head_html: HEAD, tail_html: TAIL, new_name: 'x' });
  assert.equal(v.status, 403);
  sessionUser = ME;
  const f = await api('POST', `/content/pages/${FOREIGN_PAGE}/split`, {
    head_html: '<p>a</p>', tail_html: '<p>b</p>', new_name: 'x',
  });
  assert.equal(f.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(FOREIGN_BOOK).n, 1);
  const nf = await api('POST', '/content/pages/999999/split', { head_html: '<p>a</p>', tail_html: '<p>b</p>', new_name: 'x' });
  assert.equal(nf.status, 404);
});

test('Split: Top-Level-Seite (ohne Kapitel) landet direkt dahinter auf Buchebene', async () => {
  db.prepare('UPDATE pages SET chapter_id = NULL WHERE page_id = ?').run(PAGE_B);
  const r = await api('POST', `/content/pages/${PAGE_B}/split`, {
    head_html: '<p>Danach eins.</p>', tail_html: '<p>Danach zwei.</p>', new_name: 'Nachher (2)',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tail.chapter_id, null);
  const tree = require('../../db/book-order').getOrder(BOOK).tree;
  const top = tree.filter(n => n.type === 'page').map(n => n.id);
  assert.equal(top.indexOf(r.json.tail.id), top.indexOf(PAGE_B) + 1);
});

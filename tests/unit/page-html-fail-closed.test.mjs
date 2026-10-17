// Page-HTML-Sanitizer am Content-Store-Chokepoint fail closed: scheitert
// cleanPageHtml, wird NICHTS geschrieben (kein Roh-HTML mit `onerror` in der
// DB), und der Fehler traegt einen 4xx-Status + i18n-Key. Dazu der konkrete
// Ausloeser: tief verschachteltes Inline-Markup sprengte den Call-Stack.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('page-html-fail-closed');

// Sanitizer-Wurf simulieren: BEVOR localdb ihn destrukturiert.
const htmlClean = require('../../lib/html-clean');
const origClean = htmlClean.cleanPageHtml;
htmlClean.cleanPageHtml = (h) => {
  if (typeof h === 'string' && h.includes('SANITIZER_BOOM')) throw new RangeError('Maximum call stack size exceeded');
  return origClean(h);
};

require('../../db/migrations');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');
const de = require('../../public/js/i18n/de.json');
const en = require('../../public/js/i18n/en.json');

const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9101, 'B', now, now);

const DEEP = (n) => '<p><img src=x onerror=alert(1)></p>' + '<b>'.repeat(n) + 'x' + '</b>'.repeat(n);
const bodyOf = (id) => db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(id).body_html;

test('tief verschachteltes Markup: Sanitizer laeuft durch, onerror faellt', async () => {
  const page = await contentStore.createPage({ book_id: 9101, name: 'Tief', html: DEEP(10000) });
  assert.ok(!bodyOf(page.id).includes('onerror'));
  await contentStore.savePage(page.id, { html: DEEP(12000) });
  const body = bodyOf(page.id);
  assert.ok(!body.includes('onerror'));
  assert.ok(body.includes('<b><b>'), 'legitimer (tiefer) Inhalt bleibt erhalten');
});

test('savePage: Sanitizer-Wurf schreibt nicht, 422 HTML_SANITIZE_FAILED', async () => {
  const page = await contentStore.createPage({ book_id: 9101, name: 'S', html: '<p>alt</p>' });
  const before = bodyOf(page.id);
  await assert.rejects(
    () => contentStore.savePage(page.id, { html: '<p><img src=x onerror=alert(1)>SANITIZER_BOOM</p>' }),
    (e) => e.code === 'HTML_SANITIZE_FAILED' && e.status === 422 && e.message === 'error.HTML_SANITIZE_FAILED',
  );
  assert.equal(bodyOf(page.id), before, 'Body unveraendert');
});

test('createPage: Sanitizer-Wurf legt keine Seite an', async () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
  await assert.rejects(
    () => contentStore.createPage({ book_id: 9101, name: 'X', html: '<img src=x onerror=alert(1)>SANITIZER_BOOM' }),
    (e) => e.code === 'HTML_SANITIZE_FAILED',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, n);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pages WHERE body_html LIKE '%onerror%'").get().n, 0);
});

test('splitPage: Sanitizer-Wurf aendert keine der beiden Seiten', async () => {
  const page = await contentStore.createPage({ book_id: 9101, name: 'Split', html: '<p>a</p><p>b</p>' });
  const before = bodyOf(page.id);
  const n = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
  await assert.rejects(
    () => contentStore.splitPage(page.id, { headHtml: '<p>a</p>', tailHtml: '<p onclick=x>SANITIZER_BOOM</p>', newName: 'T' }),
    (e) => e.code === 'HTML_SANITIZE_FAILED',
  );
  assert.equal(bodyOf(page.id), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pages').get().n, n);
});

test('i18n-Key error.HTML_SANITIZE_FAILED in beiden Locales', () => {
  assert.ok(de['error.HTML_SANITIZE_FAILED']);
  assert.ok(en['error.HTML_SANITIZE_FAILED']);
});

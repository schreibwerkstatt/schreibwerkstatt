// Gate für zwei Offline-/PWA-Kleinteile:
//
//   1. Navigations-Reads (Buchliste, Baum) fallen offline vom `fresh`-Read auf
//      den Cache zurück (repo/content.js#_getNav). Sonst öffnet ein Buchwechsel
//      im Zug nicht einmal ein Buch, das komplett offline liegt — der Wechsel
//      liest fresh. Abschnitts-Reads bekommen den Rückfall NICHT: ihr fresh ist
//      die Konsistenzzusage vor einem Schreiben.
//   2. Der Start-Verbraucher der installierten App (app/boot/file-launch.js)
//      erkennt .swbook und reicht Shortcut-Ziele als Hash durch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOfFile, launchHash } from '../../public/js/app/boot/file-launch.js';

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return handler(String(url)); };
  return calls;
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => body,
});

const { contentRepo } = await import('../../public/js/repo/content.js');

test('bookTree fresh: offline (SW-503) fällt auf den Cache-Read zurück', async () => {
  const calls = stubFetch((url) => (url.includes('__fresh')
    ? json(503, { error: 'offline' })
    : json(200, { chapters: [], topPages: [] })));
  const tree = await contentRepo.bookTree(5, { fresh: true });
  assert.deepEqual(tree, { chapters: [], topPages: [] });
  assert.deepEqual(calls, ['/content/books/5/tree?__fresh=1', '/content/books/5/tree']);
});

test('listBooks fresh: offline fällt auf den Cache-Read zurück', async () => {
  stubFetch((url) => (url.includes('__fresh') ? json(503, { error: 'offline' }) : json(200, [{ id: 1 }])));
  assert.deepEqual(await contentRepo.listBooks({ fresh: true }), [{ id: 1 }]);
});

test('bookTree fresh: eine echte Serverantwort (403) wird nicht überdeckt', async () => {
  const calls = stubFetch(() => json(403, { error_code: 'FORBIDDEN' }));
  await assert.rejects(contentRepo.bookTree(5, { fresh: true }), (e) => e.status === 403);
  assert.equal(calls.length, 1);
});

test('loadPage fresh: KEIN Rückfall — fresh ist dort eine Konsistenzzusage', async () => {
  const calls = stubFetch(() => json(503, { error: 'offline' }));
  await assert.rejects(contentRepo.loadPage(7, { fresh: true }), (e) => e.status === 503);
  assert.equal(calls.length, 1);
});

test('kindOfFile: nur .swbook wird angenommen', () => {
  assert.equal(kindOfFile('Roman.swbook'), 'swbook');
  assert.equal(kindOfFile('ROMAN.SWBOOK'), 'swbook');
  assert.equal(kindOfFile('Roman.zip'), null);
  assert.equal(kindOfFile(undefined), null);
});

test('launchHash: Shortcut-Ziel als Hash, nur wenn es sich ändert', () => {
  assert.equal(launchHash('https://x.test/#meine-buecher', '#book/1'), '#meine-buecher');
  assert.equal(launchHash('https://x.test/#meine-buecher', '#meine-buecher'), null);
  assert.equal(launchHash('https://x.test/', '#book/1'), null);
  assert.equal(launchHash(undefined, ''), null);
  assert.equal(launchHash('kaputt', ''), null);
});

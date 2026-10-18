// lib/sync/image-resolver.js — App-Seitenbilder im Push beider Blog-Syncs.
// `/content/page-image/<id>` ist relativ adressiert und liegt in der DB; vorher
// fiel es als „keine absolute URL" aus jedem Push heraus. Erlaubt ist nur ein
// Bild aus DEMSELBEN Buch (die ID steht im User-HTML).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('sync-image-resolver');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const schema = (await import('../../db/schema.js')).default;
const contentStore = (await import('../../lib/content-store/index.js')).default;
const { insertPageImage } = (await import('../../db/page-images.js')).default;
const { makeImageResolver, resolveImagesInTree } = (await import('../../lib/sync/image-resolver.js')).default;
const { parseHTML } = await import('linkedom');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function uploader() {
  const uploads = [];
  const upload = async ({ data, filename, mimeType }) => {
    uploads.push({ len: data.length, filename, mimeType });
    return { src: `https://files.test/${filename}`, id: uploads.length };
  };
  return { uploads, upload };
}

test('Seitenbild aus dem eigenen Buch wird hochgeladen, aus fremdem Buch verworfen', async () => {
  schema.upsertBookByName(9301, 'Bilder-Buch');
  schema.upsertBookByName(9302, 'Fremdes Buch');
  const own = await contentStore.createPage({ book_id: 9301, name: 'A', html: '<p>a</p>' }, null);
  const foreign = await contentStore.createPage({ book_id: 9302, name: 'B', html: '<p>b</p>' }, null);
  const ownImg = insertPageImage({ pageId: own.id, mime: 'image/png', image: PNG });
  const foreignImg = insertPageImage({ pageId: foreign.id, mime: 'image/png', image: PNG });

  const { uploads, upload } = uploader();
  const resolve = makeImageResolver({ upload, bookId: 9301 });
  const r = await resolve(`/content/page-image/${ownImg}`);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].mimeType, 'image/png');
  assert.match(r.src, /^https:\/\/files\.test\//);

  assert.equal(await resolve(`/content/page-image/${foreignImg}`), null);
  assert.equal(uploads.length, 1);
});

test('isHosted: beim Ziel liegende Bilder bleiben ohne Upload', async () => {
  const { uploads, upload } = uploader();
  const resolve = makeImageResolver({ upload, isHosted: (u) => u.hostname.endsWith('hubspotusercontent-eu1.net') });
  const src = 'https://x.hubspotusercontent-eu1.net/hubfs/a.png';
  assert.deepEqual(await resolve(src), { src, id: null });
  assert.equal(uploads.length, 0);
});

test('resolveImagesInTree: ersetzt src, setzt ID-Attribut, entfernt verworfene Bilder samt leerer Figur', async () => {
  const { document } = parseHTML('<!doctype html><html><body><div id="r"><figure><img src="a"><figcaption>x</figcaption></figure><p><img src="keep"></p></div></body></html>');
  const root = document.getElementById('r');
  const n = await resolveImagesInTree(root, async (src) => (src === 'keep' ? { src: 'https://h/k.png', id: 9 } : null), { idAttr: 'data-wp-id' });
  assert.equal(n, 1);
  assert.equal(root.querySelector('figure'), null);
  const img = root.querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://h/k.png');
  assert.equal(img.getAttribute('data-wp-id'), '9');
});

// ── Bild-Cache (db/sync-media-cache.js): kein erneuter Upload ──────────────

function memCache() {
  const m = new Map();
  return { m, get: (k) => m.get(k) || null, put: (k, v) => m.set(k, v) };
}

test('Cache: dieselbe data:-URI wird nur einmal hochgeladen, Treffer zaehlt nicht als Upload', async () => {
  const { uploads, upload } = uploader();
  const cache = memCache();
  const resolve = makeImageResolver({ upload, cache });
  const src = `data:image/png;base64,${PNG.toString('base64')}`;
  const a = await resolve(src);
  const b = await resolve(src);
  assert.equal(uploads.length, 1);
  assert.equal(b.src, a.src);
  assert.equal(a.cached, undefined);
  assert.equal(b.cached, true);
  assert.ok([...cache.m.keys()][0].startsWith('sha256:'));
});

test('Cache: fremde URL — Treffer spart Fetch und Upload', async () => {
  const { uploads, upload } = uploader();
  const cache = memCache();
  cache.put('url:https://img.example/a.png', { src: 'https://files.test/a.png', id: 9 });
  let fetched = 0;
  const resolve = makeImageResolver({ upload, cache, fetchImpl: async () => { fetched++; throw new Error('no'); } });
  const r = await resolve('https://img.example/a.png');
  assert.equal(r.src, 'https://files.test/a.png');
  assert.equal(fetched, 0);
  assert.equal(uploads.length, 0);
});

test('Cache: ein kaputter Cache haelt den Push nicht auf (es wird hochgeladen)', async () => {
  const { uploads, upload } = uploader();
  const cache = { get: () => { throw new Error('db weg'); }, put: () => { throw new Error('db weg'); } };
  const r = await makeImageResolver({ upload, cache })(`data:image/png;base64,${PNG.toString('base64')}`);
  assert.ok(r?.src);
  assert.equal(uploads.length, 1);
});

test('data:-URI mit kaputtem %-Escape → verworfen (null), kein Wurf', async () => {
  const { uploads, upload } = uploader();
  const r = await makeImageResolver({ upload })('data:image/png,%E0%A4%A');
  assert.equal(r, null);
  assert.equal(uploads.length, 0);
});

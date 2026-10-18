// Unit tests for lib/wp-client.js: HTTPS-only, auth header,
// pagination headers, 401 mapping, 429/5xx retry-then-fail.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const mod = await import('../../lib/wp-client.js');
const {
  createWpClient,
  validateBaseUrl,
  authHeader,
  backoffMs,
  ALLOWED_STATUS,
} = mod.default ?? mod;

function makeRes({ status = 200, headers = {}, body = '' } = {}) {
  const hdr = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => hdr.get(k) ?? hdr.get(k.toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    // Der Client liest JSON mit Byte-Deckel (lib/sync/request.js#readJson).
    arrayBuffer: async () => {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    },
  };
}

function makeFetch(scripted) {
  const calls = [];
  const queue = Array.isArray(scripted) ? [...scripted] : [scripted];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return makeRes(next);
  };
  fn.calls = calls;
  return fn;
}

test('validateBaseUrl: https only, strips trailing slash', () => {
  assert.equal(validateBaseUrl('https://blog.example.com/'), 'https://blog.example.com');
  assert.equal(validateBaseUrl('https://blog.example.com/wp'), 'https://blog.example.com/wp');
  assert.throws(() => validateBaseUrl('http://blog.example.com'), /BLOG_HTTPS_REQUIRED/);
  assert.throws(() => validateBaseUrl(''), /BLOG_INVALID_URL/);
  assert.throws(() => validateBaseUrl('not-a-url'), /BLOG_INVALID_URL/);
});

test('validateBaseUrl: blocks internal hosts (SSRF literal guard)', () => {
  assert.throws(() => validateBaseUrl('https://169.254.169.254/wp'), /BLOG_BLOCKED_HOST/);
  assert.throws(() => validateBaseUrl('https://127.0.0.1/wp'), /BLOG_BLOCKED_HOST/);
  assert.throws(() => validateBaseUrl('https://10.0.0.5/wp'), /BLOG_BLOCKED_HOST/);
  assert.throws(() => validateBaseUrl('https://192.168.1.1/wp'), /BLOG_BLOCKED_HOST/);
  assert.throws(() => validateBaseUrl('https://localhost/wp'), /BLOG_BLOCKED_HOST/);
});

test('authHeader: Basic base64 of user:password', () => {
  const h = authHeader('alice', 'secret pass');
  assert.equal(h, 'Basic ' + Buffer.from('alice:secret pass').toString('base64'));
});

test('backoffMs: capped at 2000', () => {
  assert.equal(backoffMs(1), 400);
  assert.equal(backoffMs(2), 800);
  assert.ok(backoffMs(10) <= 2000);
});

test('ALLOWED_STATUS list', () => {
  assert.deepEqual(ALLOWED_STATUS, ['draft', 'publish', 'private']);
});

test('createWpClient: rejects http base_url', () => {
  assert.throws(
    () => createWpClient({
      baseUrl: 'http://blog.example.com',
      username: 'u',
      password: 'p',
      fetch: () => {},
    }),
    /BLOG_HTTPS_REQUIRED/
  );
});

test('createWpClient: requires username + password', () => {
  assert.throws(() => createWpClient({ baseUrl: 'https://x', password: 'p', fetch: () => {} }),
    /BLOG_INVALID_USERNAME/);
  assert.throws(() => createWpClient({ baseUrl: 'https://x', username: 'u', fetch: () => {} }),
    /BLOG_INVALID_PASSWORD/);
});

test('me(): GET /users/me with Basic auth', async () => {
  const fetch = makeFetch({ status: 200, body: '{"id":1,"capabilities":{"edit_posts":true}}' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'alice',
    password: 'pw',
    fetch,
  });
  const me = await wp.me();
  assert.equal(me.id, 1);
  assert.equal(fetch.calls.length, 1);
  const call = fetch.calls[0];
  assert.match(call.url, /\/wp-json\/wp\/v2\/users\/me\?context=edit/);
  assert.equal(call.init.headers.Authorization, authHeader('alice', 'pw'));
});

test('listPosts(): reads X-WP-TotalPages + X-WP-Total headers', async () => {
  const fetch = makeFetch({
    status: 200,
    headers: { 'X-WP-TotalPages': '4', 'X-WP-Total': '317' },
    body: '[{"id":1},{"id":2}]',
  });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  const { posts, totalPages, total } = await wp.listPosts({ page: 2, perPage: 100 });
  assert.equal(posts.length, 2);
  assert.equal(totalPages, 4);
  assert.equal(total, 317);
  assert.match(fetch.calls[0].url, /per_page=100/);
  assert.match(fetch.calls[0].url, /page=2/);
});

test('listPosts(): modified_after omitted when not given', async () => {
  const fetch = makeFetch({ status: 200, body: '[]' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  await wp.listPosts();
  assert.doesNotMatch(fetch.calls[0].url, /modified_after/);
});

test('401 → BLOG_AUTH_FAILED (no retry)', async () => {
  const fetch = makeFetch({ status: 401, body: '{"code":"rest_not_logged_in"}' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  await assert.rejects(() => wp.me(), /BLOG_AUTH_FAILED/);
  assert.equal(fetch.calls.length, 1);
});

test('429 → retries up to 2x then BLOG_RATE_LIMIT', async () => {
  const fetch = makeFetch([
    { status: 429, body: '' },
    { status: 429, body: '' },
    { status: 429, body: '' },
  ]);
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  await assert.rejects(() => wp.me(), /BLOG_RATE_LIMIT/);
  assert.equal(fetch.calls.length, 3);
});

test('500 then 200 → eventual success', async () => {
  const fetch = makeFetch([
    { status: 500, body: '' },
    { status: 200, body: '{"id":1}' },
  ]);
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  const me = await wp.me();
  assert.equal(me.id, 1);
  assert.equal(fetch.calls.length, 2);
});

test('createPost: rejects invalid status', async () => {
  const fetch = makeFetch({ status: 201, body: '{"id":42}' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  await assert.rejects(
    () => wp.createPost({ title: 't', content: 'c', status: 'bogus' }),
    /BLOG_INVALID_STATUS/
  );
});

test('createPost: passes through to POST /posts', async () => {
  const fetch = makeFetch({ status: 201, body: '{"id":42}' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  const post = await wp.createPost({ title: 'Hello', content: '<p>x</p>', status: 'draft' });
  assert.equal(post.id, 42);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.match(fetch.calls[0].url, /\/wp-json\/wp\/v2\/posts$/);
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.title, 'Hello');
  assert.equal(body.status, 'draft');
});

test('updatePost: POST /posts/:id', async () => {
  const fetch = makeFetch({ status: 200, body: '{"id":7,"modified_gmt":"2026-01-01T00:00:00"}' });
  const wp = createWpClient({
    baseUrl: 'https://blog.example.com',
    username: 'u',
    password: 'p',
    fetch,
  });
  const r = await wp.updatePost(7, { content: '<p>new</p>' });
  assert.equal(r.id, 7);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.match(fetch.calls[0].url, /\/wp-json\/wp\/v2\/posts\/7/);
});

test('createPost: kein Retry bei 5xx (sonst doppelter Post, wenn die Antwort verloren ging)', async () => {
  const fetch = makeFetch([
    { status: 502, body: '' },
    { status: 201, body: '{"id":42}' },
  ]);
  const wp = createWpClient({ baseUrl: 'https://blog.example.com', username: 'u', password: 'p', fetch });
  await assert.rejects(() => wp.createPost({ title: 't', content: 'c' }), /BLOG_UPSTREAM/);
  assert.equal(fetch.calls.length, 1);
});

test('createPost: 429 wird wiederholt (nicht verarbeitet)', async () => {
  const fetch = makeFetch([
    { status: 429, body: '' },
    { status: 201, body: '{"id":42}' },
  ]);
  const wp = createWpClient({ baseUrl: 'https://blog.example.com', username: 'u', password: 'p', fetch });
  const post = await wp.createPost({ title: 't', content: 'c' });
  assert.equal(post.id, 42);
  assert.equal(fetch.calls.length, 2);
});

test('updatePost: Retry bei 5xx (Update ist idempotent)', async () => {
  const fetch = makeFetch([
    { status: 503, body: '' },
    { status: 200, body: '{"id":7}' },
  ]);
  const wp = createWpClient({ baseUrl: 'https://blog.example.com', username: 'u', password: 'p', fetch });
  const post = await wp.updatePost(7, { content: 'c' });
  assert.equal(post.id, 7);
  assert.equal(fetch.calls.length, 2);
});

test('listPosts(): stabile Seitenfolge nach ID, nicht nach Aenderungsdatum', async () => {
  const fetch = makeFetch({ status: 200, body: '[]' });
  const wp = createWpClient({ baseUrl: 'https://blog.example.com', username: 'u', password: 'p', fetch });
  await wp.listPosts({ modifiedAfter: '2025-01-01T00:00:00' });
  assert.match(fetch.calls[0].url, /orderby=id/);
  assert.doesNotMatch(fetch.calls[0].url, /orderby=modified/);
});

test('403 → BLOG_FORBIDDEN (angemeldet, aber abgewiesen — nicht „Passwort falsch")', async () => {
  const fetch = makeFetch({ status: 403, body: '{}' });
  const wp = createWpClient({ baseUrl: 'https://blog.example.com', username: 'u', password: 'p', fetch });
  await assert.rejects(() => wp.me(), /BLOG_FORBIDDEN/);
});

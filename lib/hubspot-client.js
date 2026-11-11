'use strict';
// HubSpot REST-API-Wrapper. PAT-Auth (Bearer-Token), Endpoints:
//   GET   /account-info/v3/details          → Token-Test (Portal-Info, portalId)
//   GET   /cms/v3/blogs/authors             → Autorenliste (paged via `after`)
//   GET   /cms/v3/blog-settings/settings    → Blog-Liste (Content-Groups, paged via `after`)
//   GET   /cms/v3/blogs/posts               → Post-Liste (Filter contentGroupId/blogAuthorId/state)
//   GET   /cms/v3/blogs/posts/{id}          → Post (Abgleich)
//   GET   /cms/v3/blogs/posts/{id}/draft    → Draft-Buffer (Push-Vorab-Pruefung, Konflikt-Diff)
//   POST  /cms/v3/blogs/posts               → Post anlegen (Draft)
//   PATCH /cms/v3/blogs/posts/{id}/draft    → Draft-Buffer eines bestehenden Posts updaten
//                                             (Live-Version bleibt, bis der User in HubSpot
//                                             den Buffer publiziert)
//   POST  /cms/v3/blogs/posts/{id}/draft/push-live → Draft-Buffer live schalten (204)
//   POST  /cms/v3/blogs/posts/schedule      → Veroeffentlichung planen ({ id, publishDate }, 204)
//   POST  /files/v3/files                   → Bild in den File-Manager laden (Push)
//   GET   /files/v3/files/{id}              → Datei noch da? (Bild-Cache beim Abgleich)
//
// Retry, Fehler-Codes und Byte-Deckel: lib/sync/request.js (Praefix HUBSPOT,
// 401 → HUBSPOT_AUTH_FAILED, 403 → HUBSPOT_FORBIDDEN). Jeder Request hat einen
// Zeitdeckel (fetchWithTimeout) — der Host ist fest verdrahtet, kein SSRF-Guard.
//
// Rate-Limit: clientseitiges Token-Bucket (100 req / 10 s), modulglobal — ein
// PAT ist ein Account, parallele Clients teilen sich dessen Quota.

const { fetchWithTimeout } = require('./http-util');
const { requestWithRetry, readJson, codedError } = require('./sync/request');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const RATE_LIMIT_PER_WINDOW = 100;
const RATE_LIMIT_WINDOW_MS = 10_000;
// Ordner im HubSpot-File-Manager, in den der Push Bilder laedt.
const UPLOAD_FOLDER = '/schreibwerkstatt';

let _bucketTokens = RATE_LIMIT_PER_WINDOW;
let _bucketResetAt = Date.now() + RATE_LIMIT_WINDOW_MS;

async function _acquireToken() {
  for (;;) {
    const now = Date.now();
    if (now >= _bucketResetAt) {
      _bucketTokens = RATE_LIMIT_PER_WINDOW;
      _bucketResetAt = now + RATE_LIMIT_WINDOW_MS;
    }
    if (_bucketTokens > 0) {
      _bucketTokens--;
      return;
    }
    await new Promise(r => setTimeout(r, Math.max(10, _bucketResetAt - Date.now())));
  }
}

async function _request(client, path, opts = {}) {
  const { method = 'GET', body, form, query, idempotent = method !== 'POST', timeoutMs = REQUEST_TIMEOUT_MS } = opts;
  const url = new URL(HUBSPOT_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    'Authorization': `Bearer ${client.token}`,
    'Accept': 'application/json',
    'User-Agent': 'schreibwerkstatt-hubspot-sync',
  };
  // Multipart (Datei-Upload): Boundary setzt fetch selbst.
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  return requestWithRetry(() => fetchWithTimeout(url.toString(), {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    signal: client.signal || undefined,
  }, timeoutMs, { fetchImpl: client.fetch }), {
    prefix: 'HUBSPOT',
    signal: client.signal,
    idempotent,
    maxRetries: MAX_RETRIES,
    statusCodes: { 401: 'AUTH_FAILED', 403: 'FORBIDDEN' },
    beforeAttempt: _acquireToken,
  });
}

const _json = (res) => readJson(res, { prefix: 'HUBSPOT' });

async function* _paged(client, path, query = {}, limit = 100) {
  let after;
  for (;;) {
    const res = await _request(client, path, { query: { ...query, limit, after } });
    const data = await _json(res);
    for (const r of (Array.isArray(data?.results) ? data.results : [])) yield r;
    after = data?.paging?.next?.after;
    if (!after) return;
  }
}

async function _collect(gen) {
  const all = [];
  for await (const x of gen) all.push(x);
  return all;
}

function createHubspotClient({ token, fetch: fetchImpl, signal } = {}) {
  if (!token || typeof token !== 'string') throw codedError('HUBSPOT_TOKEN_REQUIRED');
  const client = {
    token,
    fetch: fetchImpl || null,
    signal: signal || null,
  };
  const enc = (id) => encodeURIComponent(String(id));

  return {
    async me() {
      return _json(await _request(client, '/account-info/v3/details'));
    },
    async listAuthors() {
      return _collect(_paged(client, '/cms/v3/blogs/authors'));
    },
    async listBlogs() {
      return _collect(_paged(client, '/cms/v3/blog-settings/settings'));
    },
    // Filter-Syntax der v3-API: Property ohne Operator-Suffix = Gleichheit.
    iteratePosts({ authorId, blogId, state = 'PUBLISHED', limit = 100 } = {}) {
      return _paged(client, '/cms/v3/blogs/posts',
        { blogAuthorId: authorId, contentGroupId: blogId, state }, limit);
    },
    /** Posts eines Blogs mit genau diesem Titel (`name`). Der Filter geht als
     *  Gleichheits-Parameter mit; da HubSpot unbekannte Filter still ignoriert,
     *  wird zusaetzlich lokal verglichen und nach `maxPages` Seiten abgebrochen. */
    async findPostsByName({ blogId, name, state, maxPages = 20 } = {}) {
      const want = String(name || '').trim();
      if (!want) return [];
      const out = [];
      let pages = 0;
      let after;
      for (;;) {
        const res = await _request(client, '/cms/v3/blogs/posts', {
          query: { contentGroupId: blogId, name: want, state, archived: false, limit: 100, after },
        });
        const data = await _json(res);
        for (const p of (Array.isArray(data?.results) ? data.results : [])) {
          if (String(p?.name || '').trim() !== want) continue;
          if (blogId && p.contentGroupId != null && String(p.contentGroupId) !== String(blogId)) continue;
          if (state && postStatus(p).state && postStatus(p).state !== state) continue;
          if (p.archived || p.archivedAt) continue;
          out.push(p);
        }
        after = data?.paging?.next?.after;
        if (!after || ++pages >= maxPages) return out;
      }
    },
    async getPost(postId) {
      return _json(await _request(client, `/cms/v3/blogs/posts/${enc(postId)}`));
    },
    async getPostDraft(postId) {
      return _json(await _request(client, `/cms/v3/blogs/posts/${enc(postId)}/draft`));
    },
    async createPost(payload) {
      return _json(await _request(client, '/cms/v3/blogs/posts', { method: 'POST', body: payload }));
    },
    async updatePostDraft(postId, payload) {
      return _json(await _request(client, `/cms/v3/blogs/posts/${enc(postId)}/draft`, {
        method: 'PATCH',
        body: payload,
      }));
    },
    /** Draft-Buffer live schalten (Live-Version = Buffer). */
    async publishDraft(postId) {
      return _json(await _request(client, `/cms/v3/blogs/posts/${enc(postId)}/draft/push-live`, {
        method: 'POST', idempotent: true,
      }));
    },
    /** Veroeffentlichung planen; `publishDate` als ISO-8601 oder Date. */
    async schedule(postId, publishDate) {
      const d = publishDate instanceof Date ? publishDate : new Date(publishDate);
      if (!postId || Number.isNaN(d.getTime())) throw codedError('HUBSPOT_SCHEDULE_INVALID');
      return _json(await _request(client, '/cms/v3/blogs/posts/schedule', {
        method: 'POST', idempotent: true, body: { id: String(postId), publishDate: d.toISOString() },
      }));
    },
    /** Datei im File-Manager (Bild-Cache-Pruefung beim Abgleich); 404 → wirft
     *  mit `HUBSPOT_HTTP_404`. */
    async getFile(fileId) {
      return _json(await _request(client, `/files/v3/files/${enc(fileId)}`));
    },
    // Bild in den File-Manager. Rueckgabe enthaelt `id` + `url` (oeffentlich,
    // nicht indexiert — die Bilder gehoeren zum Post, nicht in die Suche).
    async uploadFile({ data, filename, mimeType } = {}) {
      if (!Buffer.isBuffer(data) || !data.length) throw codedError('HUBSPOT_INVALID_MEDIA');
      const form = new FormData();
      form.append('file', new Blob([data], { type: mimeType || 'application/octet-stream' }), filename || 'upload.bin');
      form.append('fileName', filename || 'upload.bin');
      form.append('folderPath', UPLOAD_FOLDER);
      form.append('options', JSON.stringify({ access: 'PUBLIC_NOT_INDEXABLE', overwrite: false, duplicateValidationStrategy: 'RETURN_EXISTING', duplicateValidationScope: 'EXACT_FOLDER' }));
      return _json(await _request(client, '/files/v3/files', {
        method: 'POST', form, timeoutMs: UPLOAD_TIMEOUT_MS,
      }));
    },
  };
}

function _resetRateLimitForTests() {
  _bucketTokens = RATE_LIMIT_PER_WINDOW;
  _bucketResetAt = Date.now() + RATE_LIMIT_WINDOW_MS;
}

/** Zeitstempel der letzten Aenderung eines Post-/Draft-Objekts (v3 liefert
 *  `updated`, neuere Versionen `updatedAt`). */
function postUpdatedAt(post) {
  return String(post?.updated || post?.updatedAt || '');
}

/** Status-Felder eines Post-/Draft-Objekts: `state` (DRAFT | PUBLISHED |
 *  SCHEDULED …; v3 liefert je nach Endpunkt `state` oder `currentState`),
 *  `currentState` (wie HubSpot ihn meldet), `publishDate`, `url` (Live-Adresse;
 *  bei Drafts die kuenftige). Fehlendes → null. */
function postStatus(post) {
  const str = (v) => (v == null || v === '' ? null : String(v));
  return {
    state: str(post?.state || post?.currentState),
    currentState: str(post?.currentState || post?.state),
    publishDate: str(post?.publishDate),
    url: str(post?.url || post?.absoluteUrl),
  };
}

module.exports = {
  createHubspotClient,
  postUpdatedAt,
  postStatus,
  HUBSPOT_BASE,
  _resetRateLimitForTests,
};

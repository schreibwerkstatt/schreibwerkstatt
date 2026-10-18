const { isBlockedHost, assertPublicUrl, safeFetch } = require('./ssrf-guard');
const { requestWithRetry, readJson, codedError, backoffMs } = require('./sync/request');

const ALLOWED_STATUS = ['draft', 'publish', 'private'];

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

function validateBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    const err = new Error('BLOG_INVALID_URL');
    err.code = 'BLOG_INVALID_URL';
    throw err;
  }
  let u;
  try { u = new URL(raw.trim()); }
  catch {
    const err = new Error('BLOG_INVALID_URL');
    err.code = 'BLOG_INVALID_URL';
    throw err;
  }
  if (u.protocol !== 'https:') {
    const err = new Error('BLOG_HTTPS_REQUIRED');
    err.code = 'BLOG_HTTPS_REQUIRED';
    throw err;
  }
  // SSRF: literale interne Hosts (loopback, private, link-local, metadata) sofort
  // ablehnen. DNS-Namen werden zusaetzlich beim Request (assertPublicUrl) geprueft.
  if (isBlockedHost(u.hostname)) {
    const err = new Error('BLOG_BLOCKED_HOST');
    err.code = 'BLOG_BLOCKED_HOST';
    throw err;
  }
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + path;
}

function authHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

// Fetch-Fehler, die NICHT wiederholt werden: SSRF-Block (gleiches Ziel, gleiches
// Ergebnis) und Redirect-Fehler (ein Schreib-Request folgt keinem Redirect).
function _mapFetchError(err) {
  if (err?.code && String(err.code).startsWith('SSRF_')) return err;
  if (err?.code === 'FETCH_REDIRECT_LIMIT' || err?.code === 'FETCH_REDIRECT_INVALID') {
    return codedError(`BLOG_HTTP_${err.status || 310}`, { status: err.status || 310 });
  }
  return null;
}

// `idempotent`: GET und das Update eines bestehenden Posts duerfen wiederholt
// werden; Create und Media-Upload nicht (lib/sync/request.js).
async function request(client, path, opts = {}) {
  const { method = 'GET', body, query, raw, idempotent = method === 'GET' } = opts;
  const url = new URL(client.baseUrl + '/wp-json/wp/v2' + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    'Authorization': authHeader(client.username, client.password),
    'Accept': 'application/json',
    'User-Agent': 'schreibwerkstatt-blog-sync',
  };
  // raw: Binaer-Upload (Media). Body ist ein Buffer, MIME + Dateiname stehen im
  // Content-Disposition-Header (WP-Media-Endpoint erwartet das statt JSON).
  let fetchBody;
  if (raw) {
    headers['Content-Type'] = raw.contentType;
    headers['Content-Disposition'] = `attachment; filename="${String(raw.filename || 'upload.bin').replace(/["\r\n]/g, '')}"`;
    fetchBody = raw.body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  // SSRF: safeFetch prueft den Zielhost (DNS-Aufloesung gegen interne Ranges)
  // auf JEDEM Hop — ein Blog, der auf eine interne Adresse umleitet, kommt so
  // nicht durch. Nur GET folgt Redirects; ein Schreib-Request mit 3xx ist ein
  // Fehler (fetch wuerde POST sonst still zu GET wandeln).
  return requestWithRetry(async () => {
    const { response } = await safeFetch(url.toString(), {
      method,
      headers,
      body: fetchBody,
      signal: client.signal || undefined,
      fetchImpl: client.fetch,
      assertUrl: client.assertUrl,
      readBody: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRedirects: method === 'GET' ? MAX_REDIRECTS : 0,
    });
    return response;
  }, {
    prefix: 'BLOG',
    signal: client.signal,
    idempotent,
    // 401 = Zugangsdaten falsch. 403 ist etwas anderes: angemeldet, aber
    // abgewiesen — eine Sicherheits-Erweiterung sperrt die REST-API, oder die
    // Rolle darf diesen Beitrag nicht bearbeiten. „Passwort falsch" schickte den
    // User an die falsche Stelle.
    statusCodes: { 401: 'AUTH_FAILED', 403: 'FORBIDDEN' },
    mapFetchError: _mapFetchError,
  });
}

const _json = (res) => readJson(res, { prefix: 'BLOG' });

function createWpClient({ baseUrl, username, password, fetch: fetchImpl, signal } = {}) {
  if (!username || typeof username !== 'string') {
    const err = new Error('BLOG_INVALID_USERNAME');
    err.code = 'BLOG_INVALID_USERNAME';
    throw err;
  }
  if (!password || typeof password !== 'string') {
    const err = new Error('BLOG_INVALID_PASSWORD');
    err.code = 'BLOG_INVALID_PASSWORD';
    throw err;
  }
  const validated = validateBaseUrl(baseUrl);
  const client = {
    baseUrl: validated,
    username,
    password,
    fetch: fetchImpl || globalThis.fetch,
    signal: signal || null,
    // SSRF-Guard greift nur auf dem echten Netzpfad (Default-fetch). Wird ein
    // fetch injiziert (Tests/Mocks), gibt es keinen echten Request zu schuetzen
    // — der synchrone Literal-Block in validateBaseUrl bleibt aber aktiv.
    assertUrl: fetchImpl ? (async () => {}) : assertPublicUrl,
  };
  if (typeof client.fetch !== 'function') {
    throw new Error('BLOG_FETCH_UNAVAILABLE');
  }

  return {
    baseUrl: validated,
    async me() {
      const res = await request(client, '/users/me', { query: { context: 'edit' } });
      return _json(res);
    },
    async listPosts({ page = 1, perPage = 100, modifiedAfter } = {}) {
      const res = await request(client, '/posts', {
        query: {
          page,
          per_page: perPage,
          status: 'any',
          modified_after: modifiedAfter,
          // Nach ID statt nach `modified`: eine Seitenfolge nach Aenderungsdatum
          // verschiebt sich, sobald drueben waehrend des Laufs ein Post
          // bearbeitet wird — er rutscht ans Ende, alle folgenden eine Position
          // nach vorn, und der Post an der Seitengrenze wird nie gelesen.
          orderby: 'id',
          order: 'asc',
          context: 'edit',
          _fields: 'id,title,content,excerpt,status,modified_gmt,date_gmt,date,slug',
        },
      });
      const posts = (await _json(res)) || [];
      return {
        posts,
        totalPages: Number(res.headers.get('X-WP-TotalPages') || 1),
        total: Number(res.headers.get('X-WP-Total') || posts.length || 0),
      };
    },
    async getPost(id) {
      const res = await request(client, `/posts/${Number(id)}`, {
        query: { context: 'edit' },
      });
      return _json(res);
    },
    async createPost(payload) {
      if (payload && payload.status && !ALLOWED_STATUS.includes(payload.status)) {
        const err = new Error('BLOG_INVALID_STATUS');
        err.code = 'BLOG_INVALID_STATUS';
        throw err;
      }
      const res = await request(client, '/posts', { method: 'POST', body: payload });
      return _json(res);
    },
    async updatePost(id, payload) {
      if (payload && payload.status && !ALLOWED_STATUS.includes(payload.status)) {
        const err = new Error('BLOG_INVALID_STATUS');
        err.code = 'BLOG_INVALID_STATUS';
        throw err;
      }
      const res = await request(client, `/posts/${Number(id)}`, {
        method: 'POST',
        body: payload,
        // Update eines bestehenden Posts: zweimal derselbe Stand ist kein Schaden.
        idempotent: true,
      });
      return _json(res);
    },
    // Bild-Upload in die WP-Mediathek. `data` ist ein Buffer, `mimeType` + `filename`
    // steuern den Content-Disposition-Header. Rueckgabe enthaelt `id` + `source_url`.
    async uploadMedia({ data, filename, mimeType } = {}) {
      if (!Buffer.isBuffer(data) || !data.length) {
        const err = new Error('BLOG_INVALID_MEDIA');
        err.code = 'BLOG_INVALID_MEDIA';
        throw err;
      }
      const res = await request(client, '/media', {
        method: 'POST',
        raw: { body: data, contentType: mimeType || 'application/octet-stream', filename: filename || 'upload.bin' },
      });
      return _json(res);
    },
  };
}

module.exports = {
  createWpClient,
  validateBaseUrl,
  authHeader,
  backoffMs,
  ALLOWED_STATUS,
};

const { isBlockedHost, assertPublicUrl, safeFetch } = require('./ssrf-guard');
const { requestWithRetry, readJson, codedError, backoffMs } = require('./sync/request');

// `future` = geplant (mit `date_gmt`), nur ueber den Push-Dialog — als
// Standard-Status einer Verbindung bleibt es ausgeschlossen (routes/blog.js).
const ALLOWED_STATUS = ['draft', 'publish', 'private', 'future'];

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

// Eine Blog-URL, die weiterleitet (`example.com` → `www.example.com`, http →
// https, Unterordner), ist eine falsch eingetragene URL: ein Schreib-Request
// folgt keinem Redirect (fetch wandelte POST still zu GET), und ein GET auf eine
// fremde Origin verliert die Anmeldung (safeFetch nimmt Credentials nicht mit) —
// WordPress antwortet dann 401, und „Passwort falsch" schickte den User an die
// falsche Stelle. Beides wird `BLOG_REDIRECT` mit `location` = der vermutlich
// richtigen Blog-URL (Zieladresse ohne den REST-Pfad des Requests).
function _redirectError(redirect, status) {
  return codedError('BLOG_REDIRECT', { status: status || redirect?.status || 310, location: redirect?.location || null });
}

function _suggestBase(location, requestUrl) {
  try {
    const target = new URL(location, requestUrl);
    const restPath = new URL(requestUrl).pathname.replace(/^.*?(\/wp-json\/)/, '$1');
    const at = target.pathname.indexOf('/wp-json/');
    const path = at >= 0 ? target.pathname.slice(0, at) : (target.pathname.endsWith(restPath) ? target.pathname.slice(0, -restPath.length) : '');
    return target.origin + path.replace(/\/+$/, '');
  } catch { return null; }
}

// Fetch-Fehler, die NICHT wiederholt werden: SSRF-Block (gleiches Ziel, gleiches
// Ergebnis) und Redirect-Fehler (ein Schreib-Request folgt keinem Redirect).
function _mapFetchError(err, redirect) {
  if (err?.code && String(err.code).startsWith('SSRF_')) return err;
  if (err?.code === 'FETCH_REDIRECT_LIMIT' || err?.code === 'FETCH_REDIRECT_INVALID') {
    return _redirectError(redirect, err.status);
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
  // Erste Weiterleitung des Requests merken (Ziel + ob sie die Origin wechselt):
  // safeFetch meldet nur „zu viele Redirects", nicht wohin.
  const requestUrl = url.toString();
  let redirect = null;
  const fetchImpl = async (u, init) => {
    const res = await client.fetch(u, init);
    const loc = res?.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    if (loc && !redirect) {
      let crossOrigin = false;
      try { crossOrigin = new URL(loc, u).origin !== new URL(u).origin; } catch { /* ungueltig */ }
      redirect = { status: res.status, location: _suggestBase(loc, requestUrl), crossOrigin };
    }
    return res;
  };

  try {
    return await requestWithRetry(async () => {
      const { response } = await safeFetch(requestUrl, {
        method,
        headers,
        body: fetchBody,
        signal: client.signal || undefined,
        fetchImpl,
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
      mapFetchError: (err) => _mapFetchError(err, redirect),
    });
  } catch (e) {
    // Abgewiesen NACH einer Weiterleitung auf eine andere Origin: die Anmeldung
    // ging dort nicht mit — nicht das Passwort ist falsch, sondern die URL.
    if (redirect?.crossOrigin && (e?.code === 'BLOG_AUTH_FAILED' || e?.code === 'BLOG_FORBIDDEN')) {
      throw _redirectError(redirect);
    }
    throw e;
  }
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
          // `link` (Origin fuer relative Bilder, Ansicht) und `featured_media`
          // (Beitragsbild) lesen Pull und kuenftige Funktionen mit.
          _fields: 'id,title,content,excerpt,status,modified_gmt,date_gmt,date,slug,link,featured_media',
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
    /** Metadaten eines Mediums (z.B. `alt_text`, `caption`). */
    async updateMedia(id, payload) {
      const res = await request(client, `/media/${Number(id)}`, { method: 'POST', body: payload, idempotent: true });
      return _json(res);
    },
    /** Medium noch da? (Bild-Cache beim Abgleich) — 404 wirft `BLOG_HTTP_404`. */
    async getMedia(id) {
      const res = await request(client, `/media/${Number(id)}`, { query: { context: 'edit', _fields: 'id,status' } });
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

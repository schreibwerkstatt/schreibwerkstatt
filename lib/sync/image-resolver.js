'use strict';
// Bild-Resolver fuer den Push beider Blog-Syncs (WordPress-Mediathek,
// HubSpot-File-Manager). Bestimmt pro <img>-src, was mit dem Bild passiert:
//   - schon beim Ziel gehostet (`isHosted(url)`)       → unveraendert behalten
//   - App-Seitenbild `/content/page-image/<id>`         → Bytes aus der DB + hochladen
//   - data:-URI oder fremd-gehostete http(s)-URL        → Bytes holen + hochladen
//   - alles andere (relativ, unbekanntes Schema)        → verwerfen (null)
// Fremde URLs gehen durch den SSRF-Guard (safeFetch, jeder Redirect-Hop neu
// geprueft). Fehler (Netz, MIME, Groesse, Upload) verwerfen nur das Bild, nie den
// Push. Der eigentliche Upload liegt beim Client des Anbieters (`upload`).

const crypto = require('crypto');
const { safeFetch } = require('../ssrf-guard');

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const _EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif',
};
const PAGE_IMAGE_RE = /^\/content\/page-image\/(\d+)(?:[?#].*)?$/;

function _decodeDataUri(src) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(src);
  if (!m) return null;
  const mime = m[1].trim().toLowerCase();
  // Kaputtes %-Escape (`%E0`) wirft URIError — das ist „nicht dekodierbar", kein Absturz.
  try {
    const data = m[2]
      ? Buffer.from(m[3], 'base64')
      : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { mime, data };
  } catch { return null; }
}

function _filenameFromUrl(urlStr, mime) {
  const ext = _EXT[mime] || 'bin';
  try {
    const base = new URL(urlStr).pathname.split('/').filter(Boolean).pop() || '';
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
    if (base) return `${base}.${ext}`;
  } catch { /* fallthrough */ }
  return `image.${ext}`;
}

/**
 * Liefert eine async `resolveImage(src)` → `{ src, id }` (behalten/hochgeladen)
 * oder `null` (verwerfen).
 *
 * - `upload({ data, filename, mimeType })` → `{ src, id? }` | null (Anbieter-Client)
 * - `isHosted(url: URL)` → true, wenn das Bild schon beim Ziel liegt
 * - `bookId` → erlaubt App-Seitenbilder, aber nur aus DIESEM Buch
 *   (db/page-images#getBookPageImage — die ID steht im User-HTML)
 * - `cache` → `{ get(key), put(key, { src, id }) }` (db/sync-media-cache.js):
 *   schon hochgeladene Quellen nicht noch einmal hochladen. Der Push schreibt
 *   die neue Adresse nicht in den Abschnitt zurueck — ohne Cache landete jedes
 *   Bild bei jedem Push erneut in der Mediathek. Schluessel: `sha256:` der Bytes
 *   (data:-URI, Seitenbild), `url:` der Adresse (fremd gehostet, spart den Fetch).
 *   Ein Treffer traegt `cached: true` (zaehlt nicht als Upload).
 */
function makeImageResolver({
  upload, isHosted = () => false, bookId = null, cache = null,
  signal = null, logger = null, logTag = 'Sync-Media', fetchImpl = null,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const warn = (msg) => { try { logger?.warn(`${logTag}: ${msg}`); } catch { /* noop */ } };
  // Cache-Fehler halten den Push nie auf: schlimmstenfalls wird hochgeladen.
  const cacheGet = (key) => {
    if (!cache) return null;
    try { const hit = cache.get(key); return hit && hit.src ? { ...hit, cached: true } : null; }
    catch (e) { warn(`Cache-Lesen fehlgeschlagen: ${e.message}`); return null; }
  };
  const cachePut = (key, out) => {
    if (!cache || !out?.src) return out;
    try { cache.put(key, out); } catch (e) { warn(`Cache-Schreiben fehlgeschlagen: ${e.message}`); }
    return out;
  };
  const bytesKey = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

  async function _upload(data, mime, filename) {
    if (!ALLOWED_IMAGE_MIME.has(mime)) { warn(`MIME ${mime || '?'} nicht erlaubt, Bild verworfen`); return null; }
    if (data.length > MAX_IMAGE_BYTES) { warn(`Bild ${data.length} B > Limit, verworfen`); return null; }
    const out = await upload({ data, filename, mimeType: mime });
    if (!out || !out.src) { warn('Upload lieferte keine URL'); return null; }
    return { src: out.src, id: out.id != null ? out.id : null };
  }

  async function _tryUpload(data, mime, filename, what) {
    try { return await _upload(data, mime, filename); }
    catch (e) { warn(`${what}-Upload fehlgeschlagen: ${e.code || e.message}`); return null; }
  }

  return async function resolveImage(src) {
    const trimmed = String(src || '').trim();
    if (!trimmed) return null;

    if (/^data:/i.test(trimmed)) {
      const dec = _decodeDataUri(trimmed);
      if (!dec) { warn('data:-URI nicht dekodierbar'); return null; }
      const key = bytesKey(dec.data);
      return cacheGet(key) || cachePut(key, await _tryUpload(dec.data, dec.mime, `image.${_EXT[dec.mime] || 'bin'}`, 'data:'));
    }

    const pm = PAGE_IMAGE_RE.exec(trimmed);
    if (pm) {
      // Lazy: das Modul oeffnet die DB — ein reiner Resolver (Tests, kein
      // Seitenbild im Post) soll das nicht.
      const { getBookPageImage } = require('../../db/page-images');
      const row = bookId ? getBookPageImage(parseInt(pm[1], 10), bookId) : null;
      if (!row || !row.image) { warn(`Seitenbild ${pm[1]} nicht in diesem Buch, verworfen`); return null; }
      const mime = String(row.mime || '').toLowerCase();
      const data = Buffer.from(row.image);
      const key = bytesKey(data);
      return cacheGet(key) || cachePut(key, await _tryUpload(data, mime, `page-image-${pm[1]}.${_EXT[mime] || 'bin'}`, 'Seitenbild'));
    }

    let url;
    try { url = new URL(trimmed); }
    catch { warn(`src '${trimmed.slice(0, 60)}' keine absolute URL, verworfen`); return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { warn(`Schema ${url.protocol} nicht unterstuetzt`); return null; }

    if (isHosted(url)) return { src: trimmed, id: null };
    const urlKey = `url:${trimmed}`;
    const hit = cacheGet(urlKey);
    if (hit) return hit;

    let out;
    try {
      out = await safeFetch(trimmed, {
        signal: signal || undefined,
        fetchImpl: doFetch,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        maxRedirects: MAX_REDIRECTS,
        tooLargeCode: 'IMAGE_TOO_LARGE',
      });
    } catch (e) {
      if (e.code && e.code.startsWith('SSRF_')) warn(`SSRF-Guard blockt ${url.host} (oder ein Redirect-Ziel): ${e.code}`);
      else if (e.code === 'FETCH_REDIRECT_LIMIT') warn(`zu viele Redirects ab ${trimmed}`);
      else if (e.code === 'IMAGE_TOO_LARGE') warn('Bild > Limit, verworfen');
      else warn(`Fetch ${url.host} fehlgeschlagen: ${e.code || e.message}`);
      return null;
    }
    const resp = out.response;
    if (!resp.ok) { warn(`Fetch HTTP ${resp.status}`); return null; }
    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return cachePut(urlKey, await _tryUpload(out.buffer, mime, _filenameFromUrl(out.url, mime), url.host));
  };
}

/** Media-Pass ueber einen geparsten Baum: jedes <img> durch `resolveImage`
 *  schleusen. Treffer ersetzt `src` (und setzt `idAttr`, wenn der Resolver eine
 *  Anbieter-ID liefert); `null` entfernt das Bild, eine dadurch leere <figure>
 *  faellt mit weg. Zaehlt neu hochgeladene Bilder (src geaendert). */
async function resolveImagesInTree(root, resolveImage, { idAttr = null } = {}) {
  let uploaded = 0;
  if (typeof resolveImage !== 'function' || !root) return uploaded;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    let resolved = null;
    try { resolved = await resolveImage(src); }
    catch { resolved = null; }
    if (!resolved || !resolved.src) { img.remove(); continue; }
    if (resolved.src !== src) uploaded++;
    img.setAttribute('src', resolved.src);
    if (idAttr && resolved.id != null) img.setAttribute(idAttr, String(resolved.id));
  }
  root.querySelectorAll('figure').forEach(fig => {
    if (!fig.querySelector('img') && !fig.querySelector('table')) fig.remove();
  });
  return uploaded;
}

module.exports = {
  makeImageResolver,
  resolveImagesInTree,
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  _decodeDataUri,
  _filenameFromUrl,
};

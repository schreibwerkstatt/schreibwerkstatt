'use strict';
// Bild-Spiegel fuer das Zuruecklesen eines Blog-Posts (HubSpot-Import,
// „HubSpot uebernehmen", Bilder-Nachzug). Gegenstueck zum Push-Resolver
// (./image-resolver.js):
//
//   Push:  Abschnittsbild /content/page-image/<id> → Bytes → Upload beim Ziel,
//          Cache `sha256:<bytes>` → Ziel-Adresse
//   Hier:  Ziel-Adresse → Bytes → Abschnittsbild, Cache `sha256:<bytes>` →
//          Ziel-Adresse
//
// Weil beide Richtungen denselben Cache-Schluessel benutzen, findet der
// naechste Push das gespiegelte Bild im Cache und setzt die ORIGINAL-Adresse
// wieder ein — kein zweiter Upload, keine Dublette im File-Manager, und der
// Post traegt nach einem Rundweg dasselbe Bild wie vorher.
//
// Warum ueberhaupt spiegeln: Blog-Bilder liegen auf dem CDN des Anbieters, das
// die CSP der App (img-src) nicht zulaesst; ein Abschnittsbild funktioniert
// dagegen ueberall (Editoren, Share-Reader, PDF/EPUB/DOCX, offline).
//
// Fehler (Netz, Typ, Groesse, sharp) lassen das Bild mit seiner Original-
// Adresse stehen: in der App bleibt es unsichtbar (CSP), aber der Push behaelt
// eine beim Ziel gehostete Adresse unveraendert — es geht nichts verloren.
// Die Adressen kommen aus dem Post (User-Inhalt) → safeFetch (SSRF-Guard pro Hop).

const crypto = require('crypto');
const { parseHTML } = require('linkedom');
const { safeFetch } = require('../ssrf-guard');
const { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES, _decodeDataUri } = require('./image-resolver');

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
// Deckel je Post: ein Galerie-Post soll den Import nicht minutenlang halten.
const MAX_IMAGES_PER_POST = 60;
const PAGE_IMAGE_RE = /^\/content\/page-image\/(\d+)(?:[?#].*)?$/;

const sha256Key = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

/**
 * Vergleichsschluessel einer Bild-Adresse beim Ziel. HubSpot liefert dieselbe
 * Datei unter mehreren Adressen aus: CDN (`…hubspotusercontent….net/hubfs/<portal>/x.png`),
 * eigene Blog-Domain (`/hubfs/x.png`) und skaliert (`/hs-fs/hubfs/x.png?width=600`).
 * Alles ab `/hubfs/` (ohne Portal-Segment, ohne Query) zaehlt als dieselbe Datei.
 */
function remoteImageKey(src) {
  let url;
  try { url = new URL(String(src || '').trim()); } catch { return ''; }
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* roh lassen */ }
  const i = path.toLowerCase().indexOf('/hubfs/');
  if (i >= 0) return `hubfs:${path.slice(i + 7).replace(/^\d+\//, '').toLowerCase()}`;
  return `${url.host.toLowerCase().replace(/^www\./, '')}${path}`;
}

/**
 * Welche Ziel-Adressen traegt ein Abschnitt (App-HTML)? Abschnittsbilder und
 * data:-URIs ueber den Cache (`sha256:`), beim Ziel gehostete Adressen direkt.
 * Liefert Map remoteImageKey → lokales `src` (fuer Wiederverwendung beim
 * erneuten Spiegeln und fuer die Push-Sperre „Bild fehlt im Abschnitt").
 */
function appImageRemoteMap(html, { bookId, cacheGet }) {
  const out = new Map();
  if (!html || html.indexOf('<img') === -1) return out;
  const { getBookPageImage } = require('../../db/page-images');
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = String(img.getAttribute('src') || '').trim();
    if (!src) continue;
    let remote = null;
    const pm = PAGE_IMAGE_RE.exec(src);
    if (pm) {
      const row = bookId ? getBookPageImage(parseInt(pm[1], 10), bookId) : null;
      if (row?.image) remote = _cached(cacheGet, sha256Key(Buffer.from(row.image)));
    } else if (/^data:/i.test(src)) {
      const dec = _decodeDataUri(src);
      if (dec) remote = _cached(cacheGet, sha256Key(dec.data));
    } else if (/^https?:\/\//i.test(src)) {
      remote = src;
    }
    const key = remote ? remoteImageKey(remote) : '';
    if (key && !out.has(key)) out.set(key, src);
  }
  return out;
}

function _cached(cacheGet, key) {
  try { return cacheGet?.(key)?.src || null; } catch { return null; }
}

/**
 * Ein `<p>`, das nur ein Bild traegt, wird zur Abbildung (`<figure>`) — so legt
 * auch der Notebook-Editor Bilder ab (public/js/figure/figure-html.js), und nur
 * eine Abbildung bekommt eine Block-ID, Legende und Verzeichnis-Eintrag.
 */
function _figuresFromImageParagraphs(document) {
  for (const p of Array.from(document.querySelectorAll('p'))) {
    const imgs = p.querySelectorAll('img');
    if (imgs.length !== 1) continue;
    if ((p.textContent || '').trim()) continue;
    const fig = document.createElement('figure');
    fig.appendChild(imgs[0]);
    p.replaceWith(fig);
  }
}

/**
 * Bilder eines App-HTML-Stands als Abschnittsbilder von `pageId` ablegen.
 *
 * - `html`         App-HTML mit Ziel-Adressen (hubspotToAppHtml(…, { images: true }))
 * - `pageId`, `bookId`
 * - `cache`        `{ get(key), put(key, { src, id }) }` der Verbindung
 * - `previousHtml` bisheriger Abschnittsstand: schon gespiegelte Bilder werden
 *                  wiederverwendet statt erneut geholt und abgelegt
 *
 * Liefert `{ html, mirrored, reused, failed }`.
 */
async function mirrorRemoteImages({
  html, pageId, bookId, cache = null, previousHtml = '',
  signal = null, logger = null, logTag = 'Sync-Bilder', fetchImpl = null,
}) {
  const result = { html: html || '', mirrored: 0, reused: 0, failed: 0 };
  if (!html || html.indexOf('<img') === -1) return result;
  const warn = (msg) => { try { logger?.warn?.(`${logTag}: ${msg}`); } catch { /* noop */ } };
  const cacheGet = (k) => { try { return cache?.get(k) || null; } catch { return null; } };
  const cachePut = (k, v) => { try { cache?.put(k, v); } catch (e) { warn(`Cache-Schreiben fehlgeschlagen: ${e.message}`); } };
  const known = appImageRemoteMap(previousHtml, { bookId, cacheGet });

  const { preparePageImage } = require('../page-image-prepare');
  const { insertPageImage } = require('../../db/page-images');
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  _figuresFromImageParagraphs(document);

  const fetched = new Map(); // gleiche Adresse zweimal im Post → ein Abschnittsbild
  let count = 0;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const src = String(img.getAttribute('src') || '').trim();
    if (!/^https?:\/\//i.test(src)) continue;
    const key = remoteImageKey(src);
    const reuse = known.get(key) || fetched.get(key);
    if (reuse) { img.setAttribute('src', reuse); result.reused++; continue; }
    if (++count > MAX_IMAGES_PER_POST) { result.failed++; continue; }

    let out;
    try {
      out = await safeFetch(src, {
        signal: signal || undefined,
        fetchImpl: fetchImpl || globalThis.fetch,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        maxRedirects: MAX_REDIRECTS,
        tooLargeCode: 'IMAGE_TOO_LARGE',
      });
    } catch (e) {
      if (e?.name === 'AbortError' && signal?.aborted) throw e;
      warn(`Bild nicht geladen (${e.code || e.message}): ${src.slice(0, 120)}`);
      result.failed++;
      continue;
    }
    const resp = out.response;
    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!resp.ok || !ALLOWED_IMAGE_MIME.has(mime)) {
      warn(`Bild verworfen (HTTP ${resp.status}, ${mime || '?'}): ${src.slice(0, 120)}`);
      result.failed++;
      continue;
    }
    try {
      const prepared = await preparePageImage(out.buffer);
      const id = insertPageImage({
        pageId, mime: prepared.mime, width: prepared.width, height: prepared.height,
        size: prepared.buffer.length, image: prepared.buffer,
      });
      const local = `/content/page-image/${id}`;
      // Schluessel = die GESPEICHERTEN Bytes (sharp normalisiert): genau die
      // liest der Push-Resolver wieder aus der DB.
      cachePut(sha256Key(prepared.buffer), { src, id: null });
      img.setAttribute('src', local);
      fetched.set(key, local);
      result.mirrored++;
    } catch (e) {
      warn(`Bild nicht ablegbar (${e.message}): ${src.slice(0, 120)}`);
      result.failed++;
    }
  }
  result.html = root.innerHTML;
  return result;
}

module.exports = { mirrorRemoteImages, appImageRemoteMap, remoteImageKey, MAX_IMAGES_PER_POST };

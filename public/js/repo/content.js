// Frontend-Domain-Repository fuer Buch-/Kapitel-/Seiten-Inhalte.
//
// Caller (Editor, Lektorat, Chat, History, Tree) reden nur hierhin, nicht
// direkt mit den /content/*-Routen. Antwort-Shape ist das Domain-Shape der
// Content-Store-Facade (lib/content-store/backends/localdb.js).

import { stripFocusArtefacts } from '../utils.js';
import { getDeviceId } from '../device-id.js';
import { getTabId } from '../tab-id.js';
import { EVT } from '../events.js';

const GET_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 90000;
const MAX_RETRY_429 = 3;

function _parseRetryAfter(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30000, Math.round(secs * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(30000, Math.max(0, date - Date.now()));
  return null;
}

async function _fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('content timeout')), timeoutMs);
  // Externes Signal (z.B. Buchwechsel-Abort vom Caller) mit Timeout-Signal mergen,
  // damit `_get`/`_write` von aussen unterbrochen werden können.
  const external = opts?.signal;
  let detach;
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else {
      const onAbort = () => ctrl.abort(external.reason);
      external.addEventListener('abort', onAbort, { once: true });
      detach = () => external.removeEventListener('abort', onAbort);
    }
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    detach?.();
  }
}

async function _errBody(r) {
  try { return await r.json(); } catch { return null; }
}

function _httpError(method, path, status, body) {
  const err = new Error(`${method} /content/${path} HTTP ${status}`);
  err.status = status;
  err.body = body || null;
  err.code = body?.error_code || null;
  err.detail = body?.detail || null;
  return err;
}

// SW-Cache-Invalidation nach Writes: ohne Bust serviert SWR auf Folge-Reads
// die alte Fassung — ein Read-Modify-Write-Pfad (Lektorat-Save, Chat-Vorschlag)
// ueberschreibt sonst frische Server-Edits mit Stale-Daten. Postmessage an
// public/sw.js#invalidate-content-Handler im CONTENT_CACHE-Namespace.
function _invalidateContentCache(paths) {
  if (typeof navigator === 'undefined') return;
  const ctrl = navigator.serviceWorker?.controller;
  if (!ctrl) return;
  const arr = Array.isArray(paths) ? paths : [paths];
  try { ctrl.postMessage({ type: 'invalidate-content', paths: arr }); } catch {}
}

async function _get(path, { fresh = false, signal } = {}) {
  // `?__fresh=1` umgeht den SW-CONTENT_CACHE — Pflicht fuer Read-Modify-Write-
  // Pfade (Editor-Open, Lektorat-Save) damit der nachfolgende PUT nicht frische
  // Server-Edits mit Stale-Daten ueberschreibt.
  const url = '/content/' + path + (fresh ? (path.includes('?') ? '&' : '?') + '__fresh=1' : '');
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const r = await _fetchWithTimeout(url, { signal }, GET_TIMEOUT_MS);
    if (r.ok) return r.json();
    if (r.status !== 429 || attempt === MAX_RETRY_429) {
      throw _httpError('GET', path, r.status, await _errBody(r));
    }
    const wait = _parseRetryAfter(r.headers.get('Retry-After'))
      ?? Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(rs => setTimeout(rs, wait));
  }
}

async function _write(method, path, body, invalidationPaths) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const r = await _fetchWithTimeout('/content/' + path, opts, WRITE_TIMEOUT_MS);
    if (r.ok) {
      _invalidateContentCache(invalidationPaths || path);
      return r.status === 204 ? null : r.json();
    }
    if (r.status !== 429 || attempt === MAX_RETRY_429) {
      throw _httpError(method, path, r.status, await _errBody(r));
    }
    const wait = _parseRetryAfter(r.headers.get('Retry-After'))
      ?? Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(rs => setTimeout(rs, wait));
  }
}

// Navigations-Reads (Buchliste, Baum): `fresh` heisst hier „lieber den
// Serverstand" — kein Read-Modify-Write hängt daran. Scheitert der frische Read
// am Netz (der SW antwortet dann 503 `{ error: 'offline' }`), ist der Cache die
// richtige Antwort: sonst öffnet ein Buchwechsel im Zug nicht einmal ein Buch,
// das komplett offline liegt (Buchwechsel liest fresh, tree/load.js#readsFresh).
// Abschnitts-Reads bekommen diesen Rückfall bewusst NICHT — ihr `fresh` ist die
// Konsistenzzusage vor einem Schreiben.
async function _getNav(path, opts = {}) {
  try {
    return await _get(path, opts);
  } catch (e) {
    if (!opts.fresh || e?.status !== 503 || e?.body?.error !== 'offline') throw e;
    return _get(path, { ...opts, fresh: false });
  }
}

export const contentRepo = {
  // GET /content/books → [{id, name, slug, description, updated_at, created_at}]
  listBooks(opts)               { return _getNav('books', opts); },

  // GET /content/books/:id → einzelnes Buch (Domain-Shape).
  loadBook(id, opts)            { return _get('books/' + id, opts); },

  // GET /content/books/:id/tree → { chapters: [{...c, pages: [...]}], topPages: [...] }
  bookTree(id, opts)            { return _getNav('books/' + id + '/tree', opts); },

  // Sortier-SSoT.
  // GET → { tree, updated_at, updated_by }; PUT { order_json } setzt den
  // vollstaendigen Baum atomar (Validierung + Materialisierung in Tx).
  loadOrder(id, opts)           { return _get('books/' + id + '/order', opts); },
  saveOrder(id, tree) {
    return _write('PUT', 'books/' + id + '/order', { order_json: tree },
      ['books/' + id + '/order', 'books/' + id + '/tree']);
  },

  // GET /content/chapters/:id → einzelnes Kapitel.
  loadChapter(id, opts)         { return _get('chapters/' + id, opts); },

  // GET /content/pages/:id → Seite inkl. `html`.
  // `stripFocusArtefacts` haengt der Editor-Output an, der Repo-Read normalisiert
  // ihn weg — Caller bekommen niemals den Persistenz-Backup-Marker zu sehen.
  async loadPage(id, opts) {
    const page = await _get('pages/' + id, opts);
    if (page && typeof page.html === 'string') page.html = stripFocusArtefacts(page.html);
    return page;
  },

  // PUT /content/pages/:id mit `{ html?, name?, position?, chapter_id?, source? }`.
  // Server cleant html. Bei Body-Change schreibt die
  // content-store-Facade eine page_revisions-Row mit `source` (Default 'main') —
  // Frontend dispatcht danach `page-revisions:changed`, damit die Revisionsliste
  // sich aktualisiert ohne Page-Reload. SW-Invalidation muss neben der Page
  // auch die Revisionsliste umfassen, sonst liefert SWR beim folgenden Reload
  // der Liste den Stand vor dem Save.
  async savePage(id, body) {
    const hasHtml = typeof body?.html === 'string';
    // Geraet-Stempel nur bei Body-Change: macht den geraete-bewussten /changes-Feed
    // praezise (eigener Browser-Save wird ausgefiltert, andere Geraete nicht).
    // `client_tab` trennt Tabs desselben Browsers im PAGE_CONFLICT-Log.
    const payload = hasHtml ? { ...body, device_id: getDeviceId(), client_tab: getTabId() } : body;
    const inv = hasHtml ? ['pages/' + id, 'pages/' + id + '/revisions'] : ['pages/' + id];
    const out = await _write('PUT', 'pages/' + id, payload, inv);
    if (hasHtml && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVT.PAGE_REVISIONS_CHANGED, { detail: { pageId: id } }));
    }
    return out;
  },

  // POST /content/pages/:id/images — Manuskript-Bild hochladen. `file` ist ein
  // File/Blob; der Body sind die rohen Bytes (Server normalisiert via sharp).
  // Liefert { id, url, width, height, mime }. Kein SW-Cache-Bust noetig — das
  // Bild-BLOB liegt nicht im CONTENT_CACHE.
  async uploadPageImage(id, file) {
    const r = await _fetchWithTimeout('/content/pages/' + id + '/images', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }, WRITE_TIMEOUT_MS);
    if (!r.ok) throw _httpError('POST', 'pages/' + id + '/images', r.status, await _errBody(r));
    return r.json();
  },

  // Alias fuer Strukturoperationen (rename/move/reorder ohne Body-Change).
  async updatePage(id, body) {
    // Invalidiert auch das Buch-Tree-Listing, weil Rename/Move dort sichtbar wird.
    const inv = ['pages/' + id];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('PUT', 'pages/' + id, body, inv);
  },

  // POST /content/pages mit `{ book_id?, chapter_id?, name, html? }`.
  async createPage(body) {
    const inv = ['pages'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('POST', 'pages', body, inv);
  },

  // DELETE /content/pages/:id. Liefert null. `bookId` invalidiert zusaetzlich
  // den Tree-Cache (SW-SWR wuerde die geloeschte Seite sonst als Geist zeigen,
  // bis die Hintergrund-Revalidate durch ist — dasselbe Muster wie createPage).
  async deletePage(id, { bookId } = {}) {
    const deviceId = getDeviceId();
    const path = 'pages/' + id + (deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '');
    const inv = ['pages/' + id];
    if (bookId != null) inv.push('books/' + bookId + '/tree');
    return _write('DELETE', path, undefined, inv);
  },

  // GET /content/books/:id/trash — Papierkorb (geloeschte, wiederherstellbare
  // Seiten). Immer frisch: der Eintrag aendert sich mit jedem Delete/Restore.
  listTrash(bookId) {
    return _get('books/' + bookId + '/trash', { fresh: true });
  },

  // POST /content/books/:id/trash/:deletion_id/restore — legt die Seite neu an
  // (neue page_id) → Tree-Cache busten wie bei createPage.
  restoreFromTrash(bookId, deletionId) {
    return _write('POST', 'books/' + bookId + '/trash/' + deletionId + '/restore', {},
      ['pages', 'books/' + bookId + '/tree']);
  },

  // POST /content/pages/:id/revisions/:rev_id/restore — schreibt den Body der
  // Revision zurueck. Der Restore ist selbst ein Body-Write und erzeugt darum
  // eine neue Revision; er muss BEIDE Cache-Eintraege busten. Ohne den Bust auf
  // `pages/:id` liefert ein spaeterer nicht-frischer Read den Stand VOR dem
  // Restore — und der naechste Save schriebe ihn ueber den Restore zurueck
  // (derselbe Read-Modify-Write-Hazard wie bei savePage).
  async restoreRevision(pageId, revId) {
    const out = await _write('POST', `pages/${pageId}/revisions/${revId}/restore`, undefined,
      ['pages/' + pageId, 'pages/' + pageId + '/revisions']);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVT.PAGE_REVISIONS_CHANGED, { detail: { pageId } }));
    }
    return out;
  },

  // POST /content/pages/:id/move — Seite in anderes Buch verschieben.
  // body: { target_book_id, target_chapter_id? }. Invalidiert die Tree-Listings
  // BEIDER Buecher (Quelle via sourceBookId-Opt, Ziel via target_book_id).
  async movePage(id, body, { sourceBookId } = {}) {
    const inv = ['pages/' + id];
    if (sourceBookId) inv.push('books/' + sourceBookId + '/tree');
    if (body?.target_book_id) inv.push('books/' + body.target_book_id + '/tree');
    return _write('POST', 'pages/' + id + '/move', body, inv);
  },

  // POST /content/pages/:id/split — Abschnitt teilen (Notebook-Editor). body:
  // { head_html, tail_html, new_name, expected_updated_at }. Liefert
  // { head, tail } (beide Seiten im Domain-Shape). Bustet die Seite, ihre
  // Revisionen und den Baum (neue Seite + verschobene Positionen).
  async splitPage(id, body, { bookId } = {}) {
    const inv = ['pages', 'pages/' + id, 'pages/' + id + '/revisions'];
    if (bookId != null) inv.push('books/' + bookId + '/tree');
    const out = await _write('POST', 'pages/' + id + '/split', { ...body, device_id: getDeviceId() }, inv);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVT.PAGE_REVISIONS_CHANGED, { detail: { pageId: id } }));
    }
    return out;
  },

  // POST /content/chapters mit `{ book_id, name, position?, description? }`.
  async createChapter(body) {
    const inv = ['chapters'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('POST', 'chapters', body, inv);
  },

  async updateChapter(id, body) {
    const inv = ['chapters/' + id];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('PUT', 'chapters/' + id, body, inv);
  },

  async deleteChapter(id) {
    return _write('DELETE', 'chapters/' + id);
  },

  // POST /content/books mit `{ name, description? }`. Server upserted lokale books-Row.
  async createBook(body) {
    return _write('POST', 'books', body, ['books']);
  },

  async updateBook(id, body) {
    return _write('PUT', 'books/' + id, body, ['books', 'books/' + id]);
  },

  async deleteBook(id) {
    return _write('DELETE', 'books/' + id, undefined, ['books', 'books/' + id]);
  },

  // GET /content/search?query=…&book_id=… → { hits: [Page-Meta] }
  async search(query, { bookId, count } = {}) {
    const params = new URLSearchParams({ query });
    if (bookId) params.set('book_id', String(bookId));
    if (count) params.set('count', String(count));
    return _get('search?' + params.toString());
  },
};

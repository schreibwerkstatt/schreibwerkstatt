// Frontend-Domain-Repository fuer Buch-/Kapitel-/Seiten-Inhalte.
//
// Caller (Editor, Lektorat, Chat, History, Tree) reden nur hierhin, nicht
// direkt mit den /content/*-Routen. Antwort-Shape ist das Domain-Shape der
// Content-Store-Facade (lib/content-store/backends/localdb.js).

import { stripFocusArtefacts } from '../utils.js';
import { getDeviceId } from '../device-id.js';
import { getTabId } from '../tab-id.js';
import { beginSave, confirmSave, dropSave } from './save-ids.js';
import { EVT } from '../events.js';
import { dropPendingPage, dropQueuedRename, isTempId, isUndelivered, newOpKey, patchPendingPage, pendingPage, queueCreatePage, queueRename, resolveTempId } from './structure-queue.js';

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
  // TimeoutError: Aufrufer (utils/net.js#isNetworkError) werten ihn wie einen
  // Netzfehler — die Antwort kam nicht an.
  const timer = setTimeout(() => {
    const err = new Error('content timeout');
    err.name = 'TimeoutError';
    ctrl.abort(err);
  }, timeoutMs);
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
//
// Ohne Controller (harter Reload, erster Besuch — der SW ruft bewusst kein
// clients.claim()) geht die Nachricht an den aktiven Worker der Registrierung.
// Der Tab selbst liest dann zwar am SW vorbei, aber der Cache gehört dem ganzen
// Origin: der nächste kontrollierte Tab bekäme sonst den Stand vor all den
// Saves dieses Tabs. Nicht selbst per `caches.delete` räumen — bei einem
// offline gehaltenen Buch fiele der Read dann auf die ebenso alte Offline-Kopie
// zurück; der SW-Handler lädt sie nach (sw-offline.js#invalidate).
function _invalidateContentCache(paths) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const msg = { type: 'invalidate-content', paths: Array.isArray(paths) ? paths : [paths] };
  const ctrl = navigator.serviceWorker.controller;
  if (ctrl) {
    try { ctrl.postMessage(msg); } catch {}
    return;
  }
  navigator.serviceWorker.getRegistration?.()
    .then((reg) => { try { reg?.active?.postMessage(msg); } catch {} })
    .catch(() => {});
}

// Ob dieser Tab vom SW kontrolliert wird — Diagnosefeld `client_sw` am Page-PUT
// (PAGE_SAVE/PAGE_CONFLICT-Log). Ein unkontrollierter Tab liest und schreibt am
// SW-Cache vorbei; das macht den Unterschied, wenn ein anderer Tab danach eine
// veraltete Ansicht zeigt.
function _swState() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return 'none';
  return navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled';
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

async function _write(method, path, body, invalidationPaths, extraHeaders = null, timeoutMs = WRITE_TIMEOUT_MS) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const r = await _fetchWithTimeout('/content/' + path, opts, timeoutMs);
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

// Offline vormerkbar ist nur ein reines Umbenennen (repo/structure-queue.js).
const _onlyName = (body) => !!body && typeof body.name === 'string' && Object.keys(body).every((k) => k === 'name');

// Temporäre ID, deren Anlegen schon auf dem Server ist (repo/structure-queue.js
// #resolveTempId): ein später Save, ein zweiter Tab oder ein Undo adressiert
// dann den echten Abschnitt.
function _realIdFor(id) {
  return isTempId(id) ? resolveTempId(id) : null;
}

function _currentBookId() {
  try { return globalThis.Alpine?.store('nav')?.selectedBookId ?? null; } catch { return null; }
}

// Ein Struktur-Write (Kapitel/Abschnitt anlegen, löschen, verschieben, Kapitel
// umbenennen/ausschliessen, Order-PUT) ist angekommen: der Server hat den
// Strukturstand des Buchs weitergezählt. Der Baum (book/tree/catchup.js) merkt
// sich darauf, dass sein Stand nicht mehr der aktuelle ist — sonst liefe der
// nächste Order-PUT des Organizers mit dem alten Stand in ORDER_CONFLICT.
function _noteStructureWrite(bookId = null) {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVT.STRUCTURE_WRITTEN, { detail: { bookId: bookId ?? _currentBookId() } }));
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
  // `expectedUpdatedAt`: Strukturstand, auf dem der Baum beruht (Tree-Load bzw.
  // letzter PUT). Weicht er serverseitig ab → 409 ORDER_CONFLICT statt eines
  // Überschreibens fremder Umbauten. `undefined` = unbekannt → ohne Prüfung.
  async saveOrder(id, tree, { expectedUpdatedAt } = {}) {
    const body = { order_json: tree };
    if (expectedUpdatedAt !== undefined) body.expected_updated_at = expectedUpdatedAt;
    const out = await _write('PUT', 'books/' + id + '/order', body,
      ['books/' + id + '/order', 'books/' + id + '/tree']);
    _noteStructureWrite(id);
    return out;
  },

  // GET /content/chapters/:id → einzelnes Kapitel.
  loadChapter(id, opts)         { return _get('chapters/' + id, opts); },

  // GET /content/pages/:id → Seite inkl. `html`.
  // `stripFocusArtefacts` haengt der Editor-Output an, der Repo-Read normalisiert
  // ihn weg — Caller bekommen niemals den Persistenz-Backup-Marker zu sehen.
  async loadPage(id, opts) {
    // Offline angelegt (repo/structure-queue.js): existiert nur lokal.
    if (isTempId(id)) {
      const pending = pendingPage(id);
      if (pending) return pending;
      const real = _realIdFor(id);
      if (!real) throw _httpError('GET', 'pages/' + id, 404, { error_code: 'PAGE_NOT_FOUND' });
      id = real;
    }
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
  //
  // `writer` (+ `extraOwnSaveIds` aus einem Draft): Save-Kennung und die
  // Kennungen früherer, unbestätigter Saves desselben Schreibers mitschicken
  // (./save-ids.js) — der Server erkennt daran den eigenen Save mit verlorener
  // Antwort. Ohne `writer` läuft der Save wie bisher, ohne Kennung. Basis der
  // Kennung ist `expected_updated_at` — nur Vorgänger auf derselben Basis gehen mit.
  //
  // `timeoutMs` kürzt den Write-Timeout für einen Aufrufer, der einen hängenden
  // PUT lieber abbricht und neu versucht (Notebook-Editor) — die Save-Kennung
  // macht den Abbruch sicher, falls der Server doch geschrieben hat.
  async savePage(id, body, { writer = null, extraOwnSaveIds = [], timeoutMs = WRITE_TIMEOUT_MS } = {}) {
    // Offline angelegter Abschnitt: der Inhalt reist mit der Anlege-Operation.
    if (isTempId(id)) {
      const pending = patchPendingPage(id, body || {});
      if (pending) return pending;
      const real = _realIdFor(id);
      if (!real) throw _httpError('PUT', 'pages/' + id, 404, { error_code: 'PAGE_NOT_FOUND' });
      // Schon angelegt: der Save geht an den echten Abschnitt. Die Basis der
      // temporären Seite ist leer (kein Stempel) — sie war bis eben unsere.
      id = real;
    }
    const hasHtml = typeof body?.html === 'string';
    // Geraet-Stempel nur bei Body-Change: macht den geraete-bewussten /changes-Feed
    // praezise (eigener Browser-Save wird ausgefiltert, andere Geraete nicht).
    // `client_tab` trennt Tabs desselben Browsers im PAGE_CONFLICT-Log,
    // `client_sw` sagt, ob der Tab vom SW kontrolliert wird.
    const ids = hasHtml && writer ? beginSave(writer, id, extraOwnSaveIds, body?.expected_updated_at) : null;
    const payload = hasHtml ? { ...body, ...ids, device_id: getDeviceId(), client_tab: getTabId(), client_sw: _swState() } : body;
    const inv = hasHtml ? ['pages/' + id, 'pages/' + id + '/revisions'] : ['pages/' + id];
    let out;
    try { out = await _write('PUT', 'pages/' + id, payload, inv, null, timeoutMs); }
    catch (e) {
      // 4xx: der Server hat nicht geschrieben. Netzfehler/5xx: vielleicht doch.
      if (ids && e?.status >= 400 && e.status < 500) dropSave(writer, id, ids.save_id);
      throw e;
    }
    if (ids) confirmSave(writer, id, ids.save_id);
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
    if (isTempId(id)) {
      const real = _realIdFor(id);
      if (real) return contentRepo.updatePage(real, body);
      const pending = _onlyName(body) ? patchPendingPage(id, body) : null;
      if (!pending) throw _httpError('PUT', 'pages/' + id, 409, { error_code: 'PAGE_PENDING' });
      return pending;
    }
    // Invalidiert auch das Buch-Tree-Listing, weil Rename/Move dort sichtbar wird.
    const inv = ['pages/' + id];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    try {
      const out = await _write('PUT', 'pages/' + id, body, inv);
      if (typeof body?.name === 'string') dropQueuedRename('page', id);
      if (body && ('chapter_id' in body || 'position' in body)) _noteStructureWrite(body.book_id);
      return out;
    } catch (e) {
      // Offline umbenannt → vorgemerkt (repo/structure-queue.js).
      if (isUndelivered(e) && _onlyName(body) && queueRename('page', id, body.name, { bookId: _currentBookId() })) return { id, ...body, pending: true };
      throw e;
    }
  },

  // POST /content/pages mit `{ book_id?, chapter_id?, name, html? }`.
  async createPage(body) {
    const inv = ['pages'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    // Schlüssel schon beim ersten Versuch: kam er trotz Netzfehler an, liefert
    // das Nachspielen denselben Abschnitt (lib/idempotency.js).
    const opKey = newOpKey();
    try {
      const out = await _write('POST', 'pages', body, inv, { 'Idempotency-Key': opKey });
      _noteStructureWrite(body?.book_id);
      return out;
    }
    catch (e) {
      // Offline angelegt → temporäre ID, Abspielen beim Wiederverbinden.
      const pending = isUndelivered(e) ? queueCreatePage(body, { bookId: _currentBookId(), opKey }) : null;
      if (pending) return pending;
      throw e;
    }
  },

  // Echte Writes für das Abspielen der Warteschlange — ohne erneutes Vormerken.
  sendQueuedStructureOp(op) {
    if (op.op === 'createPage') {
      const inv = ['pages'];
      const bookId = op.body.book_id ?? op.bookId;
      if (bookId != null) inv.push('books/' + bookId + '/tree');
      return _write('POST', 'pages', op.body, inv, op.opKey ? { 'Idempotency-Key': op.opKey } : null)
        .then((out) => { _noteStructureWrite(bookId); return out; });
    }
    if (op.kind === 'page') return _write('PUT', 'pages/' + op.id, { name: op.name }, ['pages/' + op.id, ...(op.bookId != null ? ['books/' + op.bookId + '/tree'] : [])]);
    return _write('PUT', 'chapters/' + op.id, { name: op.name }, ['chapters/' + op.id, ...(op.bookId != null ? ['books/' + op.bookId + '/tree'] : [])])
      .then((out) => { _noteStructureWrite(op.bookId); return out; });
  },

  // DELETE /content/pages/:id. Liefert null. `bookId` invalidiert zusaetzlich
  // den Tree-Cache (SW-SWR wuerde die geloeschte Seite sonst als Geist zeigen,
  // bis die Hintergrund-Revalidate durch ist — dasselbe Muster wie createPage).
  async deletePage(id, { bookId } = {}) {
    if (isTempId(id)) {
      const real = _realIdFor(id);
      if (!real) { dropPendingPage(id); return null; }
      id = real;
    }
    const deviceId = getDeviceId();
    const path = 'pages/' + id + (deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '');
    const inv = ['pages/' + id];
    if (bookId != null) inv.push('books/' + bookId + '/tree');
    const out = await _write('DELETE', path, undefined, inv);
    _noteStructureWrite(bookId);
    return out;
  },

  // GET /content/books/:id/trash — Papierkorb (geloeschte, wiederherstellbare
  // Seiten). Immer frisch: der Eintrag aendert sich mit jedem Delete/Restore.
  listTrash(bookId) {
    return _get('books/' + bookId + '/trash', { fresh: true });
  },

  // POST /content/books/:id/trash/:deletion_id/restore — legt die Seite neu an
  // (neue page_id) → Tree-Cache busten wie bei createPage.
  async restoreFromTrash(bookId, deletionId) {
    const out = await _write('POST', 'books/' + bookId + '/trash/' + deletionId + '/restore', {},
      ['pages', 'books/' + bookId + '/tree']);
    _noteStructureWrite(bookId);
    return out;
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

  // PATCH /content/pages/:id/revisions/:rev — Revision anheften/loesen + Name.
  // Bustet Liste UND Detail: der Voll-Body ist SWR-gecacht und traegt
  // `pinned`/`label` mit (die Karte liest beides trotzdem aus der Liste).
  async pinRevision(pageId, revId, { pinned, label = null }) {
    const out = await _write('PATCH', `pages/${pageId}/revisions/${revId}`, { pinned, label },
      ['pages/' + pageId + '/revisions', `pages/${pageId}/revisions/${revId}`]);
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
    const out = await _write('POST', 'pages/' + id + '/move', body, inv);
    _noteStructureWrite(sourceBookId);
    return out;
  },

  // POST /content/pages/:id/split — Abschnitt teilen (Notebook-Editor). body:
  // { head_html, tail_html, new_name, expected_updated_at }. Liefert
  // { head, tail } (beide Seiten im Domain-Shape). Bustet die Seite, ihre
  // Revisionen und den Baum (neue Seite + verschobene Positionen).
  async splitPage(id, body, { bookId } = {}) {
    const inv = ['pages', 'pages/' + id, 'pages/' + id + '/revisions'];
    if (bookId != null) inv.push('books/' + bookId + '/tree');
    const out = await _write('POST', 'pages/' + id + '/split', { ...body, device_id: getDeviceId() }, inv);
    _noteStructureWrite(bookId);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVT.PAGE_REVISIONS_CHANGED, { detail: { pageId: id } }));
    }
    return out;
  },

  // POST /content/chapters mit `{ book_id, name, position?, description? }`.
  async createChapter(body) {
    const inv = ['chapters'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    const out = await _write('POST', 'chapters', body, inv);
    _noteStructureWrite(body?.book_id);
    return out;
  },

  // `bookId` (oder `body.book_id`) zieht den Baum-Cache des Buchs mit — sonst
  // zeigte der naechste Kaltstart aus dem SW-Cache den alten Namen/Ausschluss.
  async updateChapter(id, body, { bookId } = {}) {
    const inv = ['chapters/' + id];
    const treeBook = body?.book_id ?? bookId;
    if (treeBook != null) inv.push('books/' + treeBook + '/tree');
    try {
      const out = await _write('PUT', 'chapters/' + id, body, inv);
      if (typeof body?.name === 'string') dropQueuedRename('chapter', id);
      _noteStructureWrite(treeBook);
      return out;
    } catch (e) {
      if (isUndelivered(e) && _onlyName(body) && queueRename('chapter', id, body.name, { bookId: treeBook ?? null })) return { id, ...body, pending: true };
      throw e;
    }
  },

  async deleteChapter(id, { bookId } = {}) {
    const inv = ['chapters/' + id];
    if (bookId != null) inv.push('books/' + bookId + '/tree');
    const out = await _write('DELETE', 'chapters/' + id, undefined, inv);
    _noteStructureWrite(bookId);
    return out;
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

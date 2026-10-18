// IndexedDB-Ablage der Editor-Entwürfe (editor/draft-storage.js) plus
// Broadcast an die übrigen Tabs.
//
// Warum IndexedDB: localStorage ist auf wenige MB je Origin begrenzt und für
// den Service Worker unsichtbar. Entwürfe halten ganze Abschnitts-HTMLs, und der
// Background Sync (public/sw-drafts.js) muss sie ohne offenen Tab lesen und
// nach dem Nachsenden räumen können. Der SW liest dieselbe Datenbank — Name,
// Store und Version stehen dort als Kopie (classic Script, kein ESM-Import),
// gegated durch tests/unit/draft-idb-drift.test.mjs.
//
// Schlüssel = der localStorage-Schlüssel des Entwurfs (`editor_draft_u:<email>:<id>`),
// Wert = der Entwurfs-Datensatz. Ohne IndexedDB (Node-Tests, gesperrter
// Speicher) meldet `usable()` false und draft-storage bleibt bei localStorage.

export const DRAFT_DB = 'schreibwerkstatt-drafts';
export const DRAFT_STORE = 'drafts';
export const DRAFT_DB_VERSION = 1;
export const DRAFT_CHANNEL = 'schreibwerkstatt-drafts';
// Background-Sync-Tag (public/sw-drafts.js) und Web-Lock je Abschnitt, den
// Outbox und Service Worker teilen — nie senden beide denselben Entwurf zugleich.
export const DRAFT_SYNC_TAG = 'schreibwerkstatt-drafts';
export const DRAFT_LOCK_PREFIX = 'draft-flush:';
// Vermerk des Service Workers nach dem Nachsenden (`sent:<Entwurfs-Schlüssel>`
// → `{ savedAt, at }`): eine localStorage-Restkopie bis zu diesem Stand ist
// erledigt und wird beim Start nicht wieder nach IndexedDB getragen.
export const DRAFT_SENT_PREFIX = 'sent:';

let _dbP = null;
// Gesperrt wird IndexedDB für die Sitzung nur, wenn sie hier grundsätzlich nicht
// geht (SecurityError/InvalidStateError: privater Modus, gesperrter Speicher).
// Ein einzelner gescheiterter Write (Quota, Safari „connection lost") oder ein
// blockiertes Öffnen (ein alter Tab hält eine ältere Version) nicht: sonst
// liefen danach auch alle Löschungen ins Leere, und ein geräumter Entwurf käme
// beim nächsten Start aus IndexedDB zurück. Dann wird beim nächsten Zugriff
// neu geöffnet.
let _broken = false;
const FATAL_OPEN = new Set(['SecurityError', 'InvalidStateError', 'NotSupportedError']);
let _channel = null;

function _idb() {
  try { return globalThis.indexedDB || null; } catch { return null; }
}

function _open() {
  if (_dbP) return _dbP;
  _dbP = new Promise((resolve, reject) => {
    const req = _idb().open(DRAFT_DB, DRAFT_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DRAFT_STORE)) req.result.createObjectStore(DRAFT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('draft-idb blocked'));
  }).catch((e) => {
    _dbP = null;
    if (FATAL_OPEN.has(e?.name)) _broken = true;
    throw e;
  });
  // Verbindung vom Browser geschlossen (Speicherdruck, Versionswechsel):
  // beim nächsten Zugriff neu öffnen.
  _dbP.then((db) => { db.onclose = () => { _dbP = null; }; }).catch(() => {});
  return _dbP;
}

async function _tx(mode, fn) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    let tx;
    // Safari schliesst die Verbindung gelegentlich ohne close-Event
    // („connection is closing"): neu öffnen beim nächsten Zugriff.
    try { tx = db.transaction(DRAFT_STORE, mode); }
    catch (e) { _dbP = null; reject(e); return; }
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('draft-idb abort'));
    out = fn(tx.objectStore(DRAFT_STORE));
  });
}

function _chan() {
  if (_channel || typeof BroadcastChannel === 'undefined') return _channel;
  try { _channel = new BroadcastChannel(DRAFT_CHANNEL); } catch { _channel = null; }
  return _channel;
}

export const draftIdb = {
  usable() { return !_broken && !!_idb(); },

  // Gibt es IndexedDB überhaupt (auch wenn das Öffnen scheiterte)? Nur dann
  // kann dort ein Datensatz liegen, den ein Grabstein verdecken muss.
  present() { return !!_idb(); },

  put(key, rec) {
    return _tx('readwrite', (s) => { s.put(rec, key); });
  },

  del(key) {
    return _tx('readwrite', (s) => { s.delete(key); });
  },

  // Ein Datensatz (oder undefined) — der bestätigte Stand, den auch andere Tabs
  // und der Service Worker sehen.
  async get(key) {
    const req = await _tx('readonly', (s) => s.get(key));
    return req?.result;
  },

  // [[key, rec], …]
  async getAll() {
    const out = [];
    await _tx('readonly', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out.push([c.key, c.value]);
        c.continue();
      };
    });
    return out;
  },

  broadcast(msg) {
    try { _chan()?.postMessage(msg); } catch { /* nur Komfort: andere Tabs sehen es beim nächsten Start */ }
  },

  onMessage(fn) {
    const ch = _chan();
    if (ch) ch.onmessage = (e) => fn(e.data);
  },
};

// Background Sync anmelden: der Browser weckt den Service Worker, sobald wieder
// Netz da ist, auch ohne offenen Tab (public/sw-drafts.js). Idempotent (gleicher
// Tag). Ohne Service Worker oder ohne Sync-API (Firefox, Safari) ein No-op —
// dort sendet die Outbox beim nächsten Öffnen.
export function hasBackgroundSync() {
  return typeof globalThis.SyncManager === 'function' && !!globalThis.navigator?.serviceWorker;
}

export function requestDraftSync() {
  try {
    const sw = globalThis.navigator?.serviceWorker;
    if (!sw || typeof sw.ready?.then !== 'function') return;
    sw.ready.then((reg) => reg.sync?.register(DRAFT_SYNC_TAG)).catch(() => {});
  } catch { /* kein SW */ }
}

// `fn` exklusiv für den Entwurf von `pageId` — tab- und SW-übergreifend über
// die Web Locks API, ohne sie direkt.
export function withDraftLock(pageId, fn) {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(DRAFT_LOCK_PREFIX + pageId, fn) : fn();
}

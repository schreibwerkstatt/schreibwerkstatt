// Ein IndexedDB-Objektspeicher als kleine Promise-Schnittstelle — für die
// Offline-Warteschlangen (repo/structure-queue.js, repo/ideen-queue.js).
//
// Bewusst NICHT für die Entwürfe (editor/draft-idb.js): deren Datenbank liest
// auch der Service Worker, Name/Store/Version stehen dort als gegatete Kopie.
// Ein eigenes DB je Konsument, damit kein Versions-Upgrade eines Speichers die
// anderen (oder den SW) blockiert.
//
// `usable()` ist false ohne IndexedDB (Node-Tests, gesperrter Speicher) — der
// Konsument bleibt dann bei seinem Rückfall.
export function openIdbStore(dbName, storeName, { keyPath = null, version = 1 } = {}) {
  let dbP = null;
  const idb = () => { try { return globalThis.indexedDB || null; } catch { return null; } };
  let p = null;
  const open = () => dbP || (dbP = p = new Promise((resolve, reject) => {
    const req = idb().open(dbName, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(storeName)) {
        req.result.createObjectStore(storeName, keyPath ? { keyPath } : undefined);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Verbindung weg (Safari im Hintergrund, Speicherdruck, gelöschte
      // Website-Daten) bzw. ein anderer Tab will upgraden: beim nächsten
      // Zugriff neu öffnen. Sonst scheiterte jede Transaktion bis zum Neuladen
      // — und mit ihr jeder Flush der Warteschlange.
      const forget = () => { if (dbP === p) dbP = null; };
      db.onclose = forget;
      db.onversionchange = () => { forget(); db.close(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`${dbName} blocked`));
  }).catch((e) => { dbP = null; throw e; }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      // Safari meldet eine verlorene Verbindung mitunter ohne `close`-Event:
      // dann wirft erst das Anlegen der Transaktion. Nächster Zugriff öffnet neu.
      try { t = db.transaction(storeName, mode); }
      catch (e) { if (dbP === p) dbP = null; throw e; }
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error(`${dbName} abort`));
      const r = fn(t.objectStore(storeName));
      if (r) r.onsuccess = () => { out = r.result; };
    });
  };
  return {
    usable: () => !!idb(),
    getAll: () => tx('readonly', (s) => s.getAll()),
    put: (rec, key) => tx('readwrite', (s) => (key === undefined ? s.put(rec) : s.put(rec, key))),
    del: (key) => tx('readwrite', (s) => s.delete(key)),
  };
}

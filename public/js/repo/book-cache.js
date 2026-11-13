// Per-Buch-Cache für Lese-Antworten, die mehrere Konsumenten im Browser teilen
// (Quellenliste, Verweis-Ziele). Ein Muster, ein Ort: liegt bei den übrigen
// Daten-Zugriffen in repo/, weil weder Quellen noch Querverweise der Besitzer
// der Mechanik sind.
//
// Semantik:
//  - ein Fetch je Buch, solange der Cache hält;
//  - gleichzeitige Aufrufer teilen sich den laufenden Fetch (In-flight-Dedup);
//  - eine Invalidierung WÄHREND des Fetches verwirft dessen Antwort als
//    Cache-Kandidaten — sie könnte den Stand vor der Änderung tragen. Der
//    wartende Aufrufer bekommt sie trotzdem (sie ist nicht falscher als vorher),
//    der nächste Aufruf holt neu.
//  - Fehler werden nicht gecacht.

/**
 * @template T
 * @param {(bookKey: string) => Promise<T>} fetcher
 * @returns {{ load: (bookId: string|number) => Promise<T>, invalidate: (bookId?: string|number|null) => void }}
 */
export function makeBookCache(fetcher) {
  const cache = new Map();
  const inflight = new Map();

  function invalidate(bookId = null) {
    if (bookId == null) { cache.clear(); inflight.clear(); }
    else { const key = String(bookId); cache.delete(key); inflight.delete(key); }
  }

  function load(bookId) {
    const key = String(bookId);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(() => fetcher(key))
      .then((out) => { if (inflight.get(key) === p) cache.set(key, out); return out; })
      .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
    return p;
  }

  return { load, invalidate };
}

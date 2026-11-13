// Quellenliste eines Buchs — ein Fetch pro Buch, geteilt von allen Konsumenten
// im Notebook-Editor.
//
// Zwei Konsumenten, die dieselbe Liste brauchen und sie nie doppelt holen
// sollen: der Beleg-Picker im Edit-Modus (editor/notebook/toolbar/cite.js) und
// das Quellen-Popover in der Leseansicht (cards/editor-entities-card.js).
//
// Der Cache ist bewusst modulweit (nicht an einer Karte), weil er den Wechsel
// zwischen Lese- und Edit-Modus ueberleben soll. Invalidiert wird er von aussen:
// die Quellen-Karte dispatcht `sources:changed`, wenn sie eine Quelle anlegt,
// aendert, zuordnet oder loescht — beide Konsumenten haengen `invalidateSourceCache`
// an dieses Event (und an `book:changed`).

import { makeBookCache } from '../repo/book-cache.js';
import { fetchJson } from '../utils/net.js';

// Dedup laufender Fetches + Schutz gegen `sources:changed` waehrend eines
// Fetches (dessen Antwort traegt den alten Stand) liegen in makeBookCache.
const _sources = makeBookCache(async (key) => {
  const list = await fetchJson(`/sources?book_id=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  return Array.isArray(list) ? list : [];
});

export function invalidateSourceCache(bookId = null) {
  _sources.invalidate(bookId);
}

/** Quellen des Buchs (`GET /sources?book_id=`). Wirft bei HTTP-Fehler — die
 *  Konsumenten entscheiden selbst, ob das ein Hinweis im Panel oder ein
 *  stiller Leerzustand ist. */
export function loadBookSources(bookId) {
  return _sources.load(bookId);
}

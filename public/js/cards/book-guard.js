// Buch-Guard nach `await`: Loader lesen die Buch-ID vor dem Fetch und schreiben
// das Ergebnis danach in die Karte. Wechselt der User in der Zwischenzeit das
// Buch, landet sonst die Antwort des alten Buchs in der Karte des neuen (und
// überschreibt dort den gerade frisch geladenen Stand).
//
//   const bookId = Alpine.store('nav').selectedBookId;
//   const data = await fetchJson(`/x/${bookId}`);
//   if (!isSelectedBook(bookId)) return;
//   this.xData = data;

/** true, wenn `bookId` (noch) das aktuell gewählte Buch ist. */
export function isSelectedBook(bookId) {
  const current = window.Alpine?.store('nav')?.selectedBookId;
  return bookId != null && bookId !== '' && String(bookId) === String(current ?? '');
}

/**
 * Lade-Token für Loader, die mehrfach laufen können (Öffnen, Refresh,
 * Buchwechsel): zählt `ctx[key]` hoch und liefert ein Prädikat, das nur so
 * lange `true` bleibt, wie (a) kein jüngerer Load derselben Karte gestartet
 * wurde und (b) `bookId` noch das gewählte Buch ist. Ohne (a) überholt ein
 * langsamer erster Load den schnellen zweiten desselben Buchs.
 *
 *   const isCurrent = loadToken(this, '_xLoadSeq', bookId);
 *   const data = await fetchJson(`/x/${bookId}`);
 *   if (!isCurrent()) return;
 *
 * `bookId` weglassen = das beim Aufruf gewählte Buch. `isCurrent.latest()`
 * prüft nur die Sequenz — für Ladeanzeigen im `finally`: der jüngste Load räumt
 * sie auch nach einem Buchwechsel (sonst bliebe sie stehen), ein überholter
 * nicht (sonst verschwände sie mitten im laufenden jüngeren Load).
 * @param {object} ctx
 * @param {string} key
 * @param {string|number} [bookId]
 * @returns {(() => boolean) & { latest: () => boolean }}
 */
export function loadToken(ctx, key, bookId) {
  const book = bookId === undefined ? window.Alpine?.store('nav')?.selectedBookId : bookId;
  const seq = (ctx[key] = (ctx[key] || 0) + 1);
  const latest = () => ctx[key] === seq;
  return Object.assign(() => latest() && isSelectedBook(book), { latest });
}

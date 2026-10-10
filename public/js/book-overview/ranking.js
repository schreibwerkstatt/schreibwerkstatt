// Geteilte Auswahlregel der Top-Listen der Buch-Uebersicht (Figuren, Orte,
// Songs) und der Spaltenauswahl der Praesenz-Matrizen.
//
// Alle vier zeigen dieselbe Frage: „welche N Eintraege durchziehen das Buch?"
// Sie lag viermal im Code, und einmal (Songs) fehlte die entscheidende Stufe —
// eine stille Abweichung, die niemandem auffiel, weil jede Kopie fuer sich
// plausibel aussah.
//
// Pure Funktion (Alpine-/DOM-frei) → direkt unit-testbar, siehe
// tests/unit/book-overview-ranking.test.mjs.

// Ab wie vielen Fundstellen ein Eintrag als „wiederkehrend" gilt.
export const RECURRING_MIN = 2;

/**
 * Nach Kennzahl absteigend sortieren und die aussagekraeftigsten Eintraege
 * waehlen.
 *
 * Reihenfolge der Auffuellung bis `limit`:
 *   1. wiederkehrende Eintraege (Kennzahl >= RECURRING_MIN),
 *   2. dahinter die uebrigen mit mindestens einer Fundstelle (> 0),
 *   3. ohne jede Fundstelle: alles.
 *
 * Warum abgestuft: Einmal-Treffer stammen meist alle aus einem einzigen
 * Kapitel und wuerden die wiederkehrenden Eintraege aus der Liste draengen —
 * gerade die sind aber die Aussage. Sie stehen darum immer vorn; freie Plaetze
 * dahinter fuellen die Einmal-Treffer auf, statt die Liste kuerzer zu lassen,
 * als sie sein koennte. Die absteigende Sortierung garantiert das bereits —
 * Wiederkehrende haben die groessere Kennzahl. Stufe 3 ist der Fall „noch
 * nichts ausgezaehlt" (keine Szenen indiziert, Kapitel-Haeufigkeiten leer):
 * dort ist eine Liste ohne Zahlen immer noch besser als gar keine.
 *
 * @param {Array<object>} items
 * @param {object} opts
 * @param {(item) => number} opts.valueOf  Kennzahl des Eintrags.
 * @param {number} [opts.limit=6]          Maximale Listenlaenge.
 * @param {number} [opts.minRecurring]     Schwelle der ersten Stufe.
 * @returns {Array<object>} Teilmenge von `items`, absteigend sortiert.
 */
export function rankPreferRecurring(items, { valueOf, limit = 6, minRecurring = RECURRING_MIN } = {}) {
  const ranked = [...(items || [])].sort((a, b) => valueOf(b) - valueOf(a));
  if (!ranked.length) return [];
  const recurring = ranked.filter(i => valueOf(i) >= minRecurring);
  const once = ranked.filter(i => valueOf(i) > 0 && valueOf(i) < minRecurring);
  const withHits = [...recurring, ...once];
  return (withHits.length ? withHits : ranked).slice(0, limit);
}

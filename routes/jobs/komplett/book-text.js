'use strict';
// Buchtext und Buchblock der Komplettanalyse-Familie — ein Bau für alle Leser.
//
// Komplettanalyse (P1 Single-Pass, P3b, Coverage-Audit), Erzählprofil und Kontinuität
// schicken den Buchtext als denselben 1h-System-Block (geteilter Präfix, kein Schema).
// Nur ein byte-identischer Block wird aus dem Cache gelesen; jede Abweichung, auch ein
// anders bereinigtes Leerzeichen, schreibt das ganze Buch neu (~500K Tokens zum doppelten
// Input-Preis). Darum gibt es die Aufbereitung genau einmal, hier.
// Gegated: tests/unit/komplett-book-block.test.mjs.

const { groupByChapter, buildSinglePassBookText, cleanPageTextForAi } = require('../shared');
const { buildBookSystemBlockText } = require('./utils');

/**
 * Bereitet geladene Abschnitte für die Calls auf. Bei Cloud-Modellen werden Entities,
 * Zero-Width-Zeichen, weiche Trennstriche und doppelte Leerzeichen entfernt; das mutiert
 * `pageContents` absichtlich, damit Multi-Pass-Chunks und Belegprüfungen denselben
 * Text sehen wie der Buchblock.
 * @returns {{ totalChars: number, groupOrder: string[], groups: Map, fullBookText: string }}
 */
function prepareBookText(pageContents, { cloud, log } = {}) {
  if (cloud) {
    let savedChars = 0;
    for (const p of pageContents) {
      const before = p.text.length;
      p.text = cleanPageTextForAi(p.text);
      savedChars += before - p.text.length;
    }
    if (savedChars > 0) log?.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt (Entities/Whitespace/ZWS).`);
  }
  const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
  const { groupOrder, groups } = groupByChapter(pageContents);
  return { totalChars, groupOrder, groups, fullBookText: buildSinglePassBookText(groups, groupOrder) };
}

/** Der geteilte 1h-Buchblock — vorderster System-Block jedes Calls, der das Buch liest. */
function bookSystemBlock(bookName, pageCount, fullBookText) {
  return { text: buildBookSystemBlockText(bookName, pageCount, fullBookText), ttl: '1h', sharedPrefix: true };
}

module.exports = { prepareBookText, bookSystemBlock };

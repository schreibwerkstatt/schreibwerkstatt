'use strict';
// Unit: Belegstellen der Kontinuitätsprüfung im Buchtext verorten
// (lib/continuity-evidence.js) — Zitat-Ortung, Fakt-Ortung über den Seitennamen,
// Beleg-Prüfung beim Speichern.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPageIndex, buildFactIndex, locateStelle, excerptOnPage, quotesFabricated, normalizeForQuoteMatch,
} = require('../../lib/continuity-evidence');

const PAGES = buildPageIndex([
  { id: 1, title: 'Der Angriff', chapter: 'Kapitel 3', chapter_id: 30, text: 'Die Bomben fielen. Marek lag reglos unter den Trümmern, niemand rührte sich.' },
  { id: 2, title: 'Heimkehr', chapter: 'Kapitel 5', chapter_id: 50, text: 'Am Morgen klopfte es. Marek öffnete die Tür und lachte laut.' },
  { id: 3, title: 'Heimkehr', chapter: 'Kapitel 9', chapter_id: 90, text: 'Gleichnamige Seite in einem anderen Kapitel.' },
]);

test('locateStelle: wörtliches Zitat → Seite, tolerant gegen Anführungszeichen-Varianten', () => {
  const p = locateStelle('Kapitel 5: „Marek öffnete die Tür und lachte“', 'Marek öffnete die Tür und lachte', PAGES, { kapitel: ['Kapitel 5'] });
  assert.equal(p.id, 2);
});

test('locateStelle: Zitat im falschen Kapitel genannt → trotzdem gefunden', () => {
  const p = locateStelle('x', 'Marek lag reglos unter den Trümmern', PAGES, { kapitel: ['Kapitel 5'] });
  assert.equal(p.id, 1);
});

test('locateStelle: Multi-Pass — zitierter Fakt liefert die Seite über seinen Seitennamen', () => {
  const facts = buildFactIndex([
    { kapitel: 'Kapitel 9', fakten: [{ subjekt: 'Marek', fakt: 'kehrt lebend nach Hause zurück', seite: 'Heimkehr' }] },
  ]);
  const p = locateStelle('Kapitel 9: «Marek: kehrt lebend nach Hause zurück»', 'Marek: kehrt lebend nach Hause zurück', PAGES, { facts });
  assert.equal(p.id, 3, 'gleichnamige Seite im Fakt-Kapitel gewinnt');
});

test('locateStelle: weder Zitat noch Fakt → null (kein Pseudo-Anker)', () => {
  assert.equal(locateStelle('Kapitel 5', 'steht so nirgends im ganzen Buch', PAGES, {}), null);
});

test('excerptOnPage: Fenster ums Zitat; ohne Treffer Seitenanfang', () => {
  assert.match(excerptOnPage(PAGES[1], 'Marek öffnete die Tür', 10), /Marek öffnete/);
  assert.equal(excerptOnPage(PAGES[1], 'fehlt hier komplett', 5), 'Am Morgen ');
});

test('quotesFabricated: ein fehlendes von zwei Zitaten genügt; leere Stellen zählen nicht', () => {
  const hay = PAGES.map(p => p.norm).join(' ');
  assert.equal(quotesFabricated(['Marek lag reglos unter den Trümmern', 'Marek öffnete die Tür'], hay), false);
  assert.equal(quotesFabricated(['Marek lag reglos unter den Trümmern', 'erfundener Satz ohne Vorlage'], hay), true);
  assert.equal(quotesFabricated(['', ''], hay), false);
  assert.equal(normalizeForQuoteMatch('«A»'), '"a"');
});

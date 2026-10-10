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

test('excerptOnPage: Fenster ums Zitat (located); ohne Treffer leer und located:false', () => {
  const hit = excerptOnPage(PAGES[1], 'Marek öffnete die Tür', 10);
  assert.equal(hit.located, true);
  assert.match(hit.text, /Marek öffnete/);
  assert.deepEqual(excerptOnPage(PAGES[1], 'fehlt hier komplett', 5), { text: '', located: false });
});

test('excerptOnPage: abweichende Anführungs-/Strich-/Leerraumformen, Soft-Hyphen, Auslassung', () => {
  const page = { text: 'Am  Morgen klopfte es.\n«Marek öff\u00adnete die Tür – und lachte», sagte sie leise.' };
  const a = excerptOnPage(page, '„Marek öffnete die Tür—und lachte“', 0);
  assert.equal(a.located, true);
  assert.match(a.text, /^Marek öff\u00adnete die Tür – und lachte$/);
  const b = excerptOnPage(page, 'Marek öffnete [...] lachte', 0);
  assert.equal(b.located, true);
  assert.equal(excerptOnPage(page, 'Marek öffnete (…) weinte bitterlich', 0).located, false, 'Reihenfolge/Wortlaut zählen');
});

test('quotesFabricated: ein fehlendes von zwei Zitaten genügt; leere Stellen zählen nicht', () => {
  const hay = PAGES.map(p => p.norm).join(' ');
  assert.equal(quotesFabricated(['Marek lag reglos unter den Trümmern', 'Marek öffnete die Tür'], hay), false);
  assert.equal(quotesFabricated(['Marek lag reglos unter den Trümmern', 'erfundener Satz ohne Vorlage'], hay), true);
  assert.equal(quotesFabricated(['', ''], hay), false);
  assert.equal(normalizeForQuoteMatch('«A»'), '"a"');
});

test('normalizeForQuoteMatch: unsichtbare Zeichen weg, Klammer-Auslassungen = «…», Apostroph-Varianten gleich', () => {
  assert.equal(normalizeForQuoteMatch('Wei\u00adter\u200bhin\ufeff'), 'weiterhin');
  for (const e of ['[…]', '[...]', '(…)', '(...)']) assert.equal(normalizeForQuoteMatch(`a ${e} b`), 'a … b');
  assert.equal(normalizeForQuoteMatch('geht´s'), normalizeForQuoteMatch('geht’s'));
  const hay = normalizeForQuoteMatch('Marek lag re\u00adglos unter den Trümmern, niemand rührte sich.');
  assert.equal(quotesFabricated(['Marek lag reglos [...] Trümmern'], hay), false);
});

// _stelleQuote: alle Zitat-Paare, Kapitel-Titel raus, längstes Zitat, Mindestgrösse.
const { _stelleQuote } = require('../../routes/jobs/komplett/utils');

test('_stelleQuote: Kapitelname in «» vor dem Zitat wird nicht als Zitat genommen', () => {
  assert.equal(_stelleQuote('Kapitel «Die Flucht»: «Marek lag reglos unter den Trümmern»'), 'Marek lag reglos unter den Trümmern');
  assert.equal(_stelleQuote('«Die lange Flucht nach Westen»: «Marek war schon tot»', { kapitel: ['Die lange Flucht nach Westen'] }), 'Marek war schon tot');
});

test('_stelleQuote: »…«, ‹…›, „…“, “…”, "…", ‚…‘', () => {
  assert.equal(_stelleQuote('Kapitel 3: »Marek lag reglos unter den Trümmern«'), 'Marek lag reglos unter den Trümmern');
  assert.equal(_stelleQuote('Kap. ‹Nacht›: ‹Marek öffnete die Tür und lachte›'), 'Marek öffnete die Tür und lachte');
  assert.equal(_stelleQuote('Kapitel 5: „Marek öffnete die Tür“'), 'Marek öffnete die Tür');
  assert.equal(_stelleQuote('Chapter 5: “Marek opened the door and laughed”'), 'Marek opened the door and laughed');
  assert.equal(_stelleQuote('Kapitel 2: "Marek lag reglos unter Trümmern"'), 'Marek lag reglos unter Trümmern');
  assert.equal(_stelleQuote('Kapitel 2: ‚Marek lag reglos unter Trümmern‘'), 'Marek lag reglos unter Trümmern');
});

test('_stelleQuote: inneres „…“ schneidet das äussere Zitat nicht ab', () => {
  assert.equal(_stelleQuote('Kapitel 4: «Er sagte „Hallo Welt“ und ging fort»'), 'Er sagte „Hallo Welt“ und ging fort');
  assert.equal(_stelleQuote('Kapitel 4: »Er sagte ‹Hallo Welt› und ging fort«'), 'Er sagte ‹Hallo Welt› und ging fort');
});

test('_stelleQuote: zwei Guillemet-Zitate — nicht der Zwischenraum, das längere gewinnt', () => {
  assert.equal(_stelleQuote('«Ja» und später «Marek öffnete die Tür»'), 'Marek öffnete die Tür');
  assert.equal(_stelleQuote('»Ja« und später »Marek öffnete die Tür«'), 'Marek öffnete die Tür');
});

test('_stelleQuote: zu kurze Zitate und Stellen ohne Anführungszeichen → kein Zitat', () => {
  assert.equal(_stelleQuote('Kapitel 2: «Ja, klar»'), '');
  assert.equal(_stelleQuote('Kapitel 2: «Unterwegs»'), '');
  assert.equal(_stelleQuote('Erzählzeit 1985'), '');
  assert.equal(_stelleQuote(null), '');
});

test('Kapitelname in «» lässt den Befund nicht als erfunden fallen', () => {
  const hay = PAGES.map(p => p.norm).join(' ');
  const q = _stelleQuote('Kapitel «Der Angriff»: «Marek lag reglos unter den Trümmern»');
  assert.equal(quotesFabricated([q], hay), false);
});

// ── Satzzeichen-Toleranz (quote-verify `ignorePunctuation`) ───────────────────
const TRUEMMER = buildPageIndex([
  { id: 7, title: 'Nacht', chapter: 'Kapitel 2', chapter_id: 20, text: 'Er lag unter den Trümmern, und niemand kam. Erst am Morgen – viel zu spät – hörte man ihn.' },
]);

test('quotesFabricated: fehlendes Komma macht ein Zitat nicht erfunden (mit hayLoose)', () => {
  const hayNorm = TRUEMMER.map(p => p.norm).join(' ');
  const hayLoose = TRUEMMER.map(p => p.loose).join(' ');
  const q = ['Trümmern und niemand kam'];
  assert.equal(quotesFabricated(q, hayNorm), true, 'ohne Toleranz: strenger Abgleich wie bisher');
  assert.equal(quotesFabricated(q, hayNorm, { hayLoose }), false);
  // Gedankenstrich statt Komma, Auslassung statt Komma
  assert.equal(quotesFabricated(['Erst am Morgen, viel zu spät, hörte man ihn'], hayNorm, { hayLoose }), false);
  assert.equal(quotesFabricated(['Trümmern … und niemand kam'], hayNorm, { hayLoose }), false);
  // ein echt erfundenes Zitat bleibt erfunden
  assert.equal(quotesFabricated(['Trümmern und alle kamen sofort'], hayNorm, { hayLoose }), true);
});

test('locateStelle/excerptOnPage: Zitat mit abweichenden Satzzeichen findet Seite und Fenster', () => {
  const p = locateStelle('Kapitel 2: «Trümmern und niemand kam»', 'Trümmern und niemand kam', TRUEMMER, { kapitel: ['Kapitel 2'] });
  assert.equal(p?.id, 7);
  const ex = excerptOnPage(p, 'Erst am Morgen, viel zu spät, hörte man ihn', 10);
  assert.equal(ex.located, true);
  assert.match(ex.text, /viel zu spät/);
});

// ── locateFact: kapitel-aware, keine Zwei-Wort-Fakten als Universal-Treffer ──
const { locateFact } = require('../../lib/continuity-evidence');

test('locateFact: ein Zwei-Wort-Fakt gewinnt nicht gegen jedes Zitat mit diesen Wörtern', () => {
  const facts = buildFactIndex([
    { kapitel: 'Kapitel 1', fakten: [{ subjekt: 'Marek', fakt: 'tot', seite: 'A' }] },
    { kapitel: 'Kapitel 4', fakten: [{ subjekt: 'Marek', fakt: 'trägt im Winter einen roten Mantel aus Wolle', seite: 'B' }] },
  ]);
  const hit = locateFact('Marek trägt den roten Mantel aus Wolle, er liegt tot im Winter', facts);
  assert.equal(hit?.seite, 'B', 'der spezifische Fakt gewinnt, nicht «Marek: tot» mit 2/2');
  assert.equal(locateFact('Marek war gestern schon fast tot vor Müdigkeit', facts), null,
    'zwei gemeinsame Wörter reichen nicht für einen Paraphrase-Treffer');
});

test('locateFact: Fakten der im Befund genannten Kapitel gehen vor', () => {
  const facts = buildFactIndex([
    { kapitel: 'Kapitel 1', fakten: [{ subjekt: 'Lena', fakt: 'hat blaue Augen und trägt eine Brille', seite: 'Früh' }] },
    { kapitel: 'Kapitel 9', fakten: [{ subjekt: 'Lena', fakt: 'hat blaue Augen und trägt eine Brille', seite: 'Spät' }] },
  ]);
  const text = 'Lena hat blaue Augen und trägt eine Brille';
  assert.equal(locateFact(text, facts)?.seite, 'Früh', 'ohne Kapitel: Buchreihenfolge');
  assert.equal(locateFact(text, facts, { kapitel: ['Kapitel 9'] })?.seite, 'Spät');
  // Paraphrase: dieselbe Präferenz
  const para = 'Lena trägt eine Brille, ihre Augen sind blau';
  assert.equal(locateFact(para, facts, { kapitel: ['Kapitel 9'] })?.seite, 'Spät');
  // genanntes Kapitel ohne Treffer → Fallback aufs übrige Buch
  assert.equal(locateFact(text, facts, { kapitel: ['Kapitel 5'] })?.seite, 'Früh');
});

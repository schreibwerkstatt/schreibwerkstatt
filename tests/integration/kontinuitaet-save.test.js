'use strict';
// saveKontinuitaetResult (routes/jobs/komplett/remap.js): Form-Härtung der Modell-
// Antwort, Selbst-Entwarnung über das Pflichtfeld `entwarnung`, typ-Normalisierung und
// Beleg-Prüfung mit Kapitelname in Anführungszeichen. Reine DB-Logik, kein AI-Mock.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { bootstrap } = require('./_helpers/setup');

const BOOK = 9310;
const EMAIL = 'test@example.com';
let ctx, saveKontinuitaetResult;
const log = { info() {}, warn() {} };

before(() => {
  ctx = bootstrap();
  ({ saveKontinuitaetResult } = require('../../routes/jobs/komplett/remap'));
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Kontinuitaet-Save' }],
    pages: [{ id: 93101, book_id: BOOK, name: 'Der Angriff' }, { id: 93102, book_id: BOOK, name: 'Heimkehr' }],
  });
});
after(() => ctx.cleanup());

const PAGES = [
  { id: 93101, title: 'Der Angriff', chapter: 'Die Flucht', chapter_id: null, text: 'Die Bomben fielen. Marek lag re­glos unter den Trümmern, niemand rührte sich.' },
  { id: 93102, title: 'Heimkehr', chapter: 'Die Rückkehr', chapter_id: null, text: 'Am Morgen klopfte es. Marek öffnete die Tür und lachte laut.' },
];

test('probleme kein Array → leeres Ergebnis statt Wurf', () => {
  for (const probleme of [null, 'kaputt', { a: 1 }, 7]) {
    const out = saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'x', probleme }, {}, {}, 'claude', log);
    assert.deepEqual(out, []);
  }
});

test('null-/Nicht-Objekt-Einträge fallen, String-Listen werden Listen, quelle nur http(s)', () => {
  const probleme = [
    null, 'text', 42, ['x'],
    { schwere: 'mittel', typ: 'figur', beschreibung: 'Marek stirbt und lebt.', stelle_a: 'Die Flucht: «Marek lag reglos unter den Trümmern»',
      stelle_b: 'Die Rückkehr: «Marek öffnete die Tür und lachte»', empfehlung: 'Erklären.',
      figuren: 'Marek', kapitel: 'Die Flucht', quelle: 'javascript:alert(1)', entwarnung: false },
    { schwere: 'niedrig', typ: 'objekt', beschreibung: 'Ring verschwindet.', stelle_a: '', stelle_b: '', empfehlung: '',
      figuren: { name: 'Lena' }, kapitel: 5, quelle: 'https://example.org/beleg' },
  ];
  const out = saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'x', probleme }, {}, {}, 'claude', log);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].figuren, ['Marek']);
  assert.deepEqual(out[0].kapitel, ['Die Flucht']);
  assert.equal(out[0].quelle ?? null, null, 'javascript:-URL wird verworfen');
  assert.deepEqual(out[1].figuren, []);
  assert.deepEqual(out[1].kapitel, []);
  assert.equal(out[1].quelle, 'https://example.org/beleg');
});

test('entwarnung===true wird verworfen, unbekannter typ wird sonstiges', () => {
  const probleme = [
    { schwere: 'mittel', typ: 'figur', beschreibung: 'Marek stirbt und lebt.', stelle_a: '', stelle_b: '', empfehlung: 'Erklären.', figuren: [], kapitel: [], entwarnung: true },
    { schwere: 'mittel', typ: 'Namensvariante', beschreibung: 'Meier heisst später Maier.', stelle_a: '', stelle_b: '', empfehlung: 'Vereinheitlichen.', figuren: [], kapitel: [], entwarnung: false },
    { schwere: 'mittel', typ: 'name', beschreibung: 'Der Hund heisst erst Bello, dann Rex.', stelle_a: '', stelle_b: '', empfehlung: 'Vereinheitlichen.', figuren: [], kapitel: [], entwarnung: false },
  ];
  const out = saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'x', probleme }, {}, {}, 'claude', log);
  assert.deepEqual(out.map(i => i.typ), ['sonstiges', 'name']);
});

test('Beleg-Prüfung: Kapitelname in «», Soft-Hyphen im Text und «[…]» lassen den Befund stehen', () => {
  const probleme = [
    { schwere: 'kritisch', typ: 'figur', beschreibung: 'Marek stirbt und lebt.',
      stelle_a: 'Kapitel «Die Flucht»: «Marek lag reglos unter den Trümmern»',
      stelle_b: 'Kapitel «Die Rückkehr»: «Marek öffnete [...] lachte laut»',
      empfehlung: 'Erklären.', figuren: ['Marek'], kapitel: ['Die Flucht', 'Die Rückkehr'], entwarnung: false },
    { schwere: 'kritisch', typ: 'figur', beschreibung: 'Erfunden.',
      stelle_a: 'Kapitel «Die Flucht»: «Marek tanzte fröhlich durch den Saal»',
      stelle_b: 'Kapitel «Die Rückkehr»: «Marek öffnete die Tür und lachte»',
      empfehlung: 'x', figuren: [], kapitel: ['Die Flucht', 'Die Rückkehr'], entwarnung: false },
  ];
  const out = saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'x', probleme }, {}, {}, 'claude', log,
    { pageContents: PAGES, requireQuoteEvidence: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].beschreibung, 'Marek stirbt und lebt.');
  assert.equal(out[0].page_a_id, 93101);
  assert.equal(out[0].page_b_id, 93102);
});

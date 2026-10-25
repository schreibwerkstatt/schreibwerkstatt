'use strict';
// Regelbasierte Dialogformat-Befunde (lib/dialogformat-rules.js): jede Regel
// schlägt an, wo sie soll, und bleibt still bei korrekter Rede, eingeschobenem
// Inquit und Begriffen/Titeln in Anführungszeichen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDialogformat, mergeRegelBefunde, ohneRegelBefunde } = require('../../lib/dialogformat-rules');

const pairs = (text) => checkDialogformat(text).map(f => [f.original, f.korrektur]);

test('meldet die Anschlussfehler zwischen Rede und Begleitsatz', () => {
  assert.deepEqual(pairs('„Komm her!“ rief sie.'), [['her!“ rief', 'her!“, rief']]);
  assert.deepEqual(pairs('„Komm her“ sagte sie.'), [['her“ sagte', 'her“, sagte']]);
  assert.deepEqual(pairs('„Komm her.“, sagte sie.'), [['her.“, sagte', 'her“, sagte']]);
  assert.deepEqual(pairs('„Komm her,“ sagte sie.'), [['her,“ sagte', 'her“, sagte']]);
  assert.deepEqual(pairs('„Komm her“, Sagte sie.'), [['her“, Sagte', 'her“, sagte']]);
  assert.deepEqual(pairs('Sie sagte leise, „Komm her.“'), [['sagte leise, „', 'sagte leise: „']]);
});

test('alle Anführungszeichen-Stile', () => {
  assert.deepEqual(pairs('«Komm her» sagte er.'), [['her» sagte', 'her», sagte']]);
  assert.deepEqual(pairs('»Komm her!« rief Anna.'), [['her!« rief', 'her!«, rief']]);
});

test('still bei korrekter Rede, eingeschobenem Inquit, Begriffen und Titeln', () => {
  for (const ok of [
    '„Komm her“, sagte sie.',
    '„Komm her!“, rief sie.',
    'Sie sagte: „Komm her.“',
    '„Komm her“, sagte sie, „aber leise.“',
    '„Wo?“ Sie lächelte.',
    'Das Wort „Liebe“ sagt viel.',
    'Er sagte, „Faust“ sei langweilig.',
  ]) assert.deepEqual(pairs(ok), [], ok);
});

test('Englisch: Komma in der Rede, nach ?/! keins', () => {
  const en = (t, o) => checkDialogformat(t, 'en', o).map(f => [f.original, f.korrektur]);
  assert.deepEqual(en('“Come here!”, she said.'), [['here!”, she said', 'here!” she said']]);
  assert.deepEqual(en('“Come here.” she said.'), [['here.” she said', 'here,” she said']]);
  assert.deepEqual(en('“Come here”, she said.'), [['here”, she said', 'here,” she said']]);
  assert.deepEqual(en('“Come here” she said.'), [['here” she said', 'here,” she said']]);
  assert.deepEqual(en('“Come here,” She said.'), [['here,” She said', 'here,” she said']]);
  assert.deepEqual(en('‘Come here.’ said Anna.'), [['here.’ said Anna', 'here,’ said Anna']]);
  for (const ok of [
    '“Come here,” she said.', '“Come here!” she shouted.', '“Come here.” She said it softly.',
    'The word “love” says a lot.', '‘Come here,’ she said, ‘and sit.’',
  ]) assert.deepEqual(en(ok), [], ok);
  // Deutsche Regeln greifen im Englischen nicht und umgekehrt.
  assert.deepEqual(en('„Komm her“ sagte sie.'), []);
  assert.deepEqual(checkDialogformat('“Come here” she said.', 'de'), []);
});

test('Britischer Sachtext: logische Zeichensetzung bleibt unangetastet', () => {
  const t = 'The plan was ‘unworkable’, she said.';
  assert.deepEqual(checkDialogformat(t, 'en', { locale: 'en-GB', sachtext: true }), []);
  assert.equal(checkDialogformat(t, 'en', { locale: 'en-US', sachtext: true }).length, 1);
  assert.equal(checkDialogformat(t, 'en', { locale: 'en-GB', sachtext: false }).length, 1);
});

test('andere Sprachen: keine Regeln', () => {
  assert.deepEqual(checkDialogformat('«Viens» dit-elle.', 'fr'), []);
});

test('KI-Befund an derselben Stelle gewinnt', () => {
  const text = '„Komm her“ sagte sie. Er ging.';
  const regel = checkDialogformat(text);
  const ki = [{ typ: 'dialogformat', original: 'her“ sagte sie', korrektur: 'her“, sagte sie', erklaerung: 'x' }];
  assert.deepEqual(mergeRegelBefunde(ki, regel, text), ki);
  assert.equal(mergeRegelBefunde([], regel, text).length, 1);
});

test('Cache-Pfad: alte Regelbefunde fallen raus und werden neu abgeleitet', () => {
  const text = '„Komm her“ sagte sie.';
  // Gecachtes Ergebnis mit einem Regelbefund einer inzwischen geänderten Regel.
  const cached = [{ typ: 'dialogformat', original: 'her“ sagte sie', korrektur: 'alt', erklaerung: 'alt', regel: true }];
  assert.deepEqual(ohneRegelBefunde(cached), []);
  const neu = mergeRegelBefunde(cached, checkDialogformat(text), text);
  assert.equal(neu.length, 1);
  assert.equal(neu[0].korrektur, 'her“, sagte');
});

test('jede Regel-Erklärung hat einen i18n-Key in de und en', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const de = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/js/i18n/de.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/js/i18n/en.json'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '../../lib/dialogformat-rules.js'), 'utf8');
  const keys = [...src.matchAll(/key: '([^']+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 11, 'Regel-Keys nicht gefunden');
  for (const k of keys) {
    assert.ok(de[k], `de.json fehlt ${k}`);
    assert.ok(en[k], `en.json fehlt ${k}`);
  }
  // Befunde tragen den Key.
  const [f] = checkDialogformat('„Komm her“ sagte sie.');
  assert.equal(f.erklaerung_key, 'lektorat.regel.kommaFehlt');
});

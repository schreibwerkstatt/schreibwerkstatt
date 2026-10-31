// Text-Logik der Synonymsuche (public/js/editor/shared/synonym-text.js) und
// Satz-Aufbereitung des Prompts (public/js/prompts/synonym.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSynonymWord, wordBoundsAt, sentenceAround, windowAround,
  isSentenceStart, matchSynonymCase, SENTENCE_MAX,
} from '../../public/js/editor/shared/synonym-text.js';
import { prepareSynonymSatz, buildSynonymPrompt, SYNONYM_SATZ_MAX } from '../../public/js/prompts/synonym.js';

test('normalizeSynonymWord: Apostrophe, zerlegte Umlaute, Randzeichen', () => {
  assert.equal(normalizeSynonymWord('geht’s'), 'geht’s');
  assert.equal(normalizeSynonymWord("geht's"), "geht's");
  assert.equal(normalizeSynonymWord('für'), 'für');
  assert.equal(normalizeSynonymWord('Haus-'), 'Haus');
  assert.equal(normalizeSynonymWord(' Wort '), 'Wort');
  assert.equal(normalizeSynonymWord('zwei Wörter'), '');
  assert.equal(normalizeSynonymWord('-'), '');
});

test('wordBoundsAt: Randzeichen bleiben ausserhalb der Ersetzung', () => {
  const t = 'Haus- und Gartenarbeit';
  const hit = wordBoundsAt(t, 2);
  assert.deepEqual(hit, { start: 0, end: 4, word: 'Haus' });
  assert.equal(wordBoundsAt('Na, geht’s?', 6).word, 'geht’s');
  assert.equal(wordBoundsAt('a  b', 2), null);
});

test('sentenceAround: Abkürzungen und Ordinalzahlen beenden keinen Satz', () => {
  const full = 'Er kam spät. Am 3. Mai sah er z. B. den Dr. Meier im Park. Dann ging er.';
  const off = full.indexOf('Park');
  assert.equal(sentenceAround(full, off, 4), 'Am 3. Mai sah er z. B. den Dr. Meier im Park.');
});

test('sentenceAround: schliessende Anführung gehört zum Satz', () => {
  const full = '«Komm schnell!» Sie lief.';
  assert.equal(sentenceAround(full, full.indexOf('schnell'), 7), '«Komm schnell!»');
});

test('sentenceAround: Absatz ohne Satzzeichen wird um das Wort gekürzt', () => {
  const full = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
  const off = full.indexOf('w300');
  const out = sentenceAround(full, off, 4);
  assert.ok(out.length <= SENTENCE_MAX + 2, `zu lang: ${out.length}`);
  assert.ok(out.includes('w300'));
  assert.ok(out.startsWith('…') && out.endsWith('…'));
});

test('windowAround: kurzer Text bleibt unverändert', () => {
  assert.equal(windowAround('kurz', 0, 4, 100), 'kurz');
});

test('isSentenceStart', () => {
  assert.equal(isSentenceStart(''), true);
  assert.equal(isSentenceStart('Er lief. '), true);
  assert.equal(isSentenceStart('Er sagte: «'), false);
  assert.equal(isSentenceStart('Er lief. «'), true);
  assert.equal(isSentenceStart('z. B. '), false);
  assert.equal(isSentenceStart('Er lief '), false);
});

test('matchSynonymCase: Satzanfang, Versalien, Satzmitte', () => {
  assert.equal(matchSynonymCase('Schnell', 'rasch', true), 'Rasch');
  assert.equal(matchSynonymCase('schnell', 'rasch', false), 'rasch');
  assert.equal(matchSynonymCase('Haus', 'Gebäude', false), 'Gebäude');
  assert.equal(matchSynonymCase('Haus', 'gebäude', false), 'gebäude');
  assert.equal(matchSynonymCase('SCHNELL', 'rasch', false), 'RASCH');
  assert.equal(matchSynonymCase('A', 'ein', true), 'Ein');
});

test('prepareSynonymSatz: markiert das erste ganze Vorkommen', () => {
  assert.equal(prepareSynonymSatz('arme', 'Die Armee und die arme Frau.'), 'Die Armee und die ⟦arme⟧ Frau.');
  assert.equal(prepareSynonymSatz('Wort', 'Kein Treffer hier.'), 'Kein Treffer hier.');
  assert.equal(prepareSynonymSatz('a', 'x ⟦a⟧ y'), 'x ⟦a⟧ y');
});

test('prepareSynonymSatz: deckelt überlange Sätze um das Wort', () => {
  const satz = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ');
  const out = prepareSynonymSatz('w500', satz);
  assert.ok(out.length <= SYNONYM_SATZ_MAX + 4);
  assert.ok(out.includes('⟦w500⟧'));
});

test('buildSynonymPrompt: Sprache folgt dem Buch', () => {
  assert.match(buildSynonymPrompt('fast', 'He ran ⟦fast⟧.', 'en'), /^Suggest up to 10 synonyms/);
  assert.match(buildSynonymPrompt('schnell', 'Er lief ⟦schnell⟧.', 'de'), /^Schlage bis zu 10 Synonyme/);
  assert.match(buildSynonymPrompt('schnell', 'x', null), /^Schlage/);
});

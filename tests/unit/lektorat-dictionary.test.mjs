// Benutzer-Wörterbuch im Lektorat (routes/jobs/lektorat-dictionary.js): Auswahl
// der Wörter einer Seite, Backstop auf Rechtschreib-Findings und der Prompt-Block
// in Einzel-/Stil-Prompt und Objektiv-Pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { dictionaryWordsOnPage, dropDictionaryFindings } = require('../../routes/jobs/lektorat-dictionary');
const { buildDictionary } = require('../../lib/dictionary-forms');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);

test('dictionaryWordsOnPage: nur ganze Wörter der Seite, in Seiten-Schreibweise, sortiert', () => {
  const set = buildDictionary(['chuchichäschtli', 'zmorge', 'gspänli', 'ort']);
  const text = 'Am Morgen gab es Zmorge. Das Chuchichäschtli war leer. Im Dorf …';
  // «ort» steht nur als Teil von «Dorf» — kein Treffer.
  assert.deepEqual(dictionaryWordsOnPage(set, text), ['Chuchichäschtli', 'Zmorge']);
});

test('dictionaryWordsOnPage: leeres Set / leerer Text', () => {
  assert.deepEqual(dictionaryWordsOnPage(buildDictionary([]), 'Text'), []);
  assert.deepEqual(dictionaryWordsOnPage(buildDictionary(['a']), ''), []);
  assert.deepEqual(dictionaryWordsOnPage(null, 'Text'), []);
});

test('dictionaryWordsOnPage: Regex-Sonderzeichen im Eintrag', () => {
  assert.deepEqual(dictionaryWordsOnPage(buildDictionary(['c++']), 'Er schrieb C++ am Abend.'), ['C++']);
});

test('dropDictionaryFindings: verwirft Rechtschreib-Findings auf Wörterbuch-Wörtern, auch mit Satzzeichen', () => {
  const fehler = [
    { typ: 'rechtschreibung', original: 'Chuchichäschtli,', korrektur: 'Küchenkästchen,' },
    { typ: 'rechtschreibung', original: '«zmorge»', korrektur: '«Frühstück»' },
    { typ: 'rechtschreibung', original: 'Fahrad', korrektur: 'Fahrrad' },
    { typ: 'grammatik', original: 'Chuchichäschtli', korrektur: 'dem Chuchichäschtli' },
  ];
  const out = dropDictionaryFindings(fehler, ['Chuchichäschtli', 'Zmorge']);
  assert.deepEqual(out.map(f => f.original), ['Fahrad', 'Chuchichäschtli']);
});

test('dictionaryWordsOnPage: Genitiv nur bei Nomen, jede Form der Seite', () => {
  const dict = buildDictionary(['Riggenbach', 'Niklaus', 'schnachte']);
  const text = 'Riggenbachs Hof. Riggenbach kam. Niklaus\' Frau. Er schnachtes und schnachte.';
  assert.deepEqual(dictionaryWordsOnPage(dict, text), ['Niklaus\'', 'Riggenbach', 'Riggenbachs', 'schnachte']);
});

test('dropDictionaryFindings: Genitivform aus der Seitenliste, auch mit Apostroph', () => {
  const fehler = [
    { typ: 'rechtschreibung', original: 'Riggenbachs', korrektur: 'x' },
    { typ: 'rechtschreibung', original: '«Niklaus\'»', korrektur: 'y' },
  ];
  assert.deepEqual(dropDictionaryFindings(fehler, ['Niklaus\'', 'Riggenbachs']), []);
});

test('dropDictionaryFindings: ohne Wörterbuch unverändert', () => {
  const fehler = [{ typ: 'rechtschreibung', original: 'x', korrektur: 'y' }];
  assert.equal(dropDictionaryFindings(fehler, []), fehler);
});

test('Prompt: Wörterbuch-Block in Einzel-, Stil- und Objektiv-Prompt, nur wenn Wörter da sind', () => {
  prompts.configurePrompts(cfg, 'claude');
  const SAMPLE = 'Das Chuchichäschtli war leer.';
  const opts = { langCode: 'de', woerterbuch: ['Chuchichäschtli'] };
  for (const p of [
    prompts.buildLektoratPrompt(SAMPLE, opts),
    prompts.buildStilLektoratPrompt(SAMPLE, opts),
    prompts.buildObjektivLektoratPrompt(SAMPLE, opts),
  ]) {
    assert.match(p, /Wörterbuch des Autors[^\n]*\n- Chuchichäschtli/);
  }
  assert.doesNotMatch(prompts.buildObjektivLektoratPrompt(SAMPLE, { langCode: 'de' }), /Wörterbuch des Autors/);
  assert.match(prompts.buildObjektivLektoratPrompt(SAMPLE, { ...opts, langCode: 'en' }), /Author's dictionary/);
});

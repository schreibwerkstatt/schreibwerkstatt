// Autorenprofil-Prompt: die zwei Verbote, die das Feature tragen.
//
// Sie stehen im Prompt-Wortlaut und sind darum nur hier pruefbar — ein
// Schema-Test saehe sie nicht. Faellt eines davon weg, liefert der Lauf genau
// das, wogegen das Feature gebaut wurde: schmeichelhafte Kanon-Vergleiche
// („erinnert an Sebald") bzw. Stilnoten statt Beschreibung.

import test from 'node:test';
import assert from 'node:assert';

const {
  buildAutorenprofilPrompt, SCHEMA_AUTORENPROFIL, AUTORENPROFIL_METRIC_LABELS,
} = await import('../../public/js/prompts/autorenprofil.js');
// lib/ ist CommonJS — per createRequire statt ueber einen import()-Umweg.
import { createRequire } from 'node:module';
const { AUTHOR_PROFILE_METRICS } = createRequire(import.meta.url)('../../lib/author-profile.js');

const base = { messung: 'Satzlaenge: A 10.1 | B 10.4', profile: [{ titel: 'A', stilprofil: 'kurz' }] };

test('Prompt verbietet Vergleiche mit anderen Autoren', () => {
  const p = buildAutorenprofilPrompt({ ...base, buecher: 3 });
  assert.match(p, /KEINE anderen Autoren/);
  assert.match(p, /ausschliesslich gegen die eigenen Buecher/);
});

test('Prompt verbietet Wertung und verlangt Belege', () => {
  const p = buildAutorenprofilPrompt({ ...base, buecher: 3 });
  assert.match(p, /WERTE NICHT/);
  assert.match(p, /Behaupte nichts/);
  // Die Messung ist Vorbefund, nicht Inhalt der Antwort — sonst gibt das Modell
  // die Tabelle in Prosa zurueck (gleiche Rahmung wie der Struktur-Check in der
  // Buchbewertung).
  assert.match(p, /verwende sie, wiederhole sie nicht/);
});

test('Ein einziges Buch: der Entwicklungs-Teil faellt weg statt leer behauptet zu werden', () => {
  const eins = buildAutorenprofilPrompt({ ...base, buecher: 1 });
  assert.match(eins, /LEERES Array/);
  assert.match(eins, /Erfinde keine/);

  const mehr = buildAutorenprofilPrompt({ ...base, buecher: 2 });
  assert.ok(!/LEERES Array/.test(mehr), 'ab zwei Buechern wird Entwicklung verlangt');
  assert.match(mehr, /VERSCHOBEN/);
});

test('Ohne Buch-Stilprofil wird das gesagt, nicht stillschweigend ausgelassen', () => {
  const p = buildAutorenprofilPrompt({ messung: 'x', profile: [], buecher: 2 });
  assert.match(p, /Fuer keines der Buecher liegt ein Stilprofil vor/);
});

test('Schema fuehrt genau die drei Felder, alle required', () => {
  assert.deepEqual(Object.keys(SCHEMA_AUTORENPROFIL.properties).sort(),
    ['autorenprofil', 'entwicklung', 'konstanten']);
  assert.deepEqual([...SCHEMA_AUTORENPROFIL.required].sort(),
    ['autorenprofil', 'entwicklung', 'konstanten']);
  assert.equal(SCHEMA_AUTORENPROFIL.additionalProperties, false);
  // Ein Befund ohne Beleg waere eine Behauptung — der Beleg ist Pflichtfeld.
  assert.ok(SCHEMA_AUTORENPROFIL.properties.konstanten.items.required.includes('beleg'));
  assert.ok(SCHEMA_AUTORENPROFIL.properties.entwicklung.items.required.includes('beleg'));
});

test('Prompt-Labels decken jede Kennzahl ab (sonst steht ein Code-Key im Prompt)', () => {
  for (const m of AUTHOR_PROFILE_METRICS) {
    assert.ok(AUTORENPROFIL_METRIC_LABELS[m.key], `Label fehlt fuer ${m.key}`);
  }
});

test('Mehrsprachig ohne gleichsprachiges Paar: Entwicklung leer, mit Begründung Sprachunterschied', () => {
  const p = buildAutorenprofilPrompt({ ...base, buecher: 2, mehrsprachig: true, entwicklungMoeglich: false });
  assert.match(p, /"entwicklung": LEERES Array/);
  assert.match(p, /Sprachunterschied, keine Entwicklung/);
  // Konstanten dürfen die Sprachgrenze überspannen, aber nicht auf sprachgebundene Zahlen.
  assert.match(p, /nur auf die Buch-Stilprofile und den Dialoganteil/);
});

test('Mehrsprachig mit gleichsprachigem Paar: Entwicklung nur innerhalb einer Sprache', () => {
  const p = buildAutorenprofilPrompt({ ...base, buecher: 3, mehrsprachig: true, entwicklungMoeglich: true });
  assert.match(p, /ausschliesslich zwischen Buechern DERSELBEN Sprache/);
  assert.doesNotMatch(p, /LEERES Array/);
});

test('Sprachnamen decken jede Messsprache ab', async () => {
  const { AUTORENPROFIL_LANGUAGE_LABELS } = await import('../../public/js/prompts/autorenprofil.js');
  for (const lang of ['de', 'en']) assert.ok(AUTORENPROFIL_LANGUAGE_LABELS[lang], lang);
});

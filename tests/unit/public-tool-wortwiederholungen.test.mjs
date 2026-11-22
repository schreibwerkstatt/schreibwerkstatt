// Oeffentliches Werkzeug /wortwiederholungen: Rechenkern + Datenschutz-Zusage.
// Die Seite verspricht «der Text verlaesst den Rechner nicht» — darum darf
// keines der beiden Module einen Netzwerkweg enthalten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'public', 'js', 'public-tools');
const { analyzeText } = await import('../../public/js/public-tools/wortwiederholungen.js');

test('nahe Wiederholung wird markiert, ferne nicht', () => {
  const filler = Array.from({ length: 50 }, (_, i) => `wort${i}`).join(' ');
  const r = analyzeText(`Der Garten lag still. Im Garten stand ein Baum. ${filler} Baum.`, { window: 40 });
  assert.deepEqual(r.repeats.map(x => x.word), ['garten'], 'Garten (nah) ja, Baum (fern) nein');
  assert.equal(r.repeats[0].count, 2, 'beide Vorkommen zählen');
  assert.equal(r.stats.repeats, 2);
});

test('Funktionswörter und kurze Wörter zählen nicht als Wiederholung', () => {
  const r = analyzeText('Und dann und dann kam er. Und dann ging er.');
  assert.deepEqual(r.repeats, []);
});

test('Sätze, Satzlänge und Durchschnitt', () => {
  const r = analyzeText('Eins zwei drei. Vier fünf!\n\nSechs sieben acht neun');
  assert.equal(r.stats.sentences, 3, 'Absatzende schliesst den Satz');
  assert.equal(r.stats.words, 9);
  assert.equal(r.stats.avg, 3);
});

test('lange Sätze ab der Schwelle, längster zuerst', () => {
  const long = Array.from({ length: 35 }, (_, i) => `w${i}`).join(' ') + '.';
  const mid = Array.from({ length: 31 }, (_, i) => `v${i}`).join(' ') + '.';
  const r = analyzeText(`${mid} Kurz. ${long}`, { long: 30 });
  assert.deepEqual(r.longSentences.map(s => s.words), [35, 31]);
  assert.ok(r.longSentences[0].text.endsWith('.'), 'Satzzeichen bleibt am Satz');
});

test('gehäufte Satzanfänge zählen auch Funktionswörter', () => {
  const r = analyzeText('Er ging. Er kam. Er sah. Sie lachte.');
  assert.deepEqual(r.openers, [{ word: 'er', count: 3 }]);
});

test('Markierungen zeigen auf Wortpositionen im Absatz', () => {
  const r = analyzeText('Regen fiel. Regen fiel wieder.');
  const p = r.paragraphs[0];
  const marked = [...r.markedByParagraph[0]].map(i => p.text.slice(p.words[i].start, p.words[i].end));
  assert.deepEqual(marked.sort(), ['Regen', 'Regen', 'fiel', 'fiel']);
});

test('leerer Text liefert leeres Ergebnis ohne Fehler', () => {
  const r = analyzeText('   ');
  assert.equal(r.stats.words, 0);
  assert.equal(r.stats.avg, 0);
});

test('Datenschutz-Zusage: die Werkzeug-Module enthalten keinen Netzwerkweg', () => {
  for (const f of fs.readdirSync(DIR)) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const rx of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/]) {
      assert.doesNotMatch(src, rx, `${f}: ${rx} — der eingefügte Text darf den Browser nicht verlassen`);
    }
  }
});

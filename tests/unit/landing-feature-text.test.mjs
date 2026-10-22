// Feature-Text der Landing-Page — Laengenrahmen aus DESIGN.md „Feature-Text
// (Landing)".
//
// Die Keys `landing.feat<N>Title/Desc` stehen als Kacheln in einem Raster auf
// der oeffentlichen Landing-Page. Ein 700-Zeichen-Block neben einem
// 80-Zeichen-Block laesst das Raster zerfallen und die kurz beschriebenen
// Features nebensaechlich wirken. Der Rahmen driftet
// ohne Gate zuverlaessig auseinander: jedes neue Feature wirkt beim Schreiben
// erklaerungsbeduerftiger als das davor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const I18N = path.join(ROOT, 'public', 'js', 'i18n');

const TITLE_MAX = 26;
const DESC_MIN = 160;
const DESC_MAX = 200;

const locales = Object.fromEntries(['de', 'en'].map(l =>
  [l, JSON.parse(fs.readFileSync(path.join(I18N, `${l}.json`), 'utf8'))]));

/** Alle vorhandenen Feature-Nummern (de ist Fallback-Locale und SSoT der Keys). */
function featureNumbers() {
  return Object.keys(locales.de)
    .map(k => k.match(/^landing\.feat(\d+)Title$/))
    .filter(Boolean)
    .map(m => Number(m[1]))
    .sort((a, b) => a - b);
}

const numbers = featureNumbers();

test('Feature-Text: Nummern sind lueckenlos ab 1', () => {
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1),
    'landing.feat<N> muss 1..N lueckenlos sein (Nummern nie umnummerieren)');
});

test('Feature-Text: jede Nummer hat Titel + Beschreibung in beiden Locales', () => {
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      assert.ok(dict[`landing.feat${n}Title`], `${loc}: landing.feat${n}Title fehlt`);
      assert.ok(dict[`landing.feat${n}Desc`], `${loc}: landing.feat${n}Desc fehlt`);
    }
  }
});

test(`Feature-Text: Titel hoechstens ${TITLE_MAX} Zeichen`, () => {
  const bad = [];
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      const v = dict[`landing.feat${n}Title`] || '';
      if (v.length > TITLE_MAX) bad.push(`${loc} feat${n} (${v.length}): ${v}`);
    }
  }
  assert.deepEqual(bad, [], `Titel zu lang (max ${TITLE_MAX}, 1–3 Woerter):\n${bad.join('\n')}`);
});

test(`Feature-Text: Beschreibung ${DESC_MIN}–${DESC_MAX} Zeichen`, () => {
  const bad = [];
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      const v = dict[`landing.feat${n}Desc`] || '';
      if (v.length < DESC_MIN || v.length > DESC_MAX) bad.push(`${loc} feat${n}: ${v.length} Zeichen`);
    }
  }
  assert.deepEqual(bad, [], `Beschreibung ausserhalb ${DESC_MIN}–${DESC_MAX}:\n${bad.join('\n')}`);
});

test('Feature-Text: Landing-Page rendert genau die vorhandenen Nummern', () => {
  // Kein Vorrat: ein Key, den die Landing nicht zeigt, sieht niemand — und
  // veraltet dann unbemerkt. Reihenfolge = Nummer.
  // Geprüft wird der KACHEL-TITEL (das <h3>) — der Titel erscheint zusätzlich
  // im Alt-Text des Produktbildes (tests/unit/landing-screenshots.test.mjs),
  // das wäre sonst eine zweite, nicht gerenderte Nummer.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');
  const rendered = [...html.matchAll(/<h3>\{\{feat(\d+)Title\}\}<\/h3>/g)].map(m => Number(m[1]));
  assert.ok(rendered.length > 0, 'landing.html rendert keinen Feature-Block');
  assert.deepEqual(rendered, numbers,
    'landing.html muss jede landing.feat<N> genau einmal in Reihenfolge rendern');
});

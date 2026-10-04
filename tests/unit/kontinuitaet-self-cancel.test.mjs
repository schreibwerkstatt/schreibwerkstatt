import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _isSelfCancelled } = require('../../routes/jobs/komplett/remap.js');

test('droppt Eintrag mit "Kein Widerspruch" in beschreibung', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Jürg ist Jahrgang 1960, Ernst 1958. Das ist korrekt. Kein Widerspruch.',
    empfehlung: 'Eintrag entfernen – kein Widerspruch.',
  }), true);
});

test('droppt Eintrag mit "Eintrag entfernen" in empfehlung', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Möglicher Konflikt mit Zeitangabe.',
    empfehlung: 'Eintrag entfernen – passt doch.',
  }), true);
});

test('droppt Eintrag mit "konsistent" in beschreibung', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Beide Angaben sind konsistent.',
    empfehlung: 'Keine Aktion nötig.',
  }), true);
});

test('droppt Eintrag mit "passt zusammen"', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Die Angaben passen zusammen.',
    empfehlung: '',
  }), true);
});

test('droppt Eintrag mit "Entwarnung"', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Bei näherer Prüfung: Entwarnung.',
    empfehlung: '',
  }), true);
});

test('behält echten Widerspruch', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Maria ist in Kapitel 3 fünf Jahre alt, in Kapitel 5 plötzlich zehn, obwohl nur ein Monat vergeht.',
    empfehlung: 'Altersangabe in Kapitel 5 korrigieren auf sechs Jahre.',
  }), false);
});

test('behält Eintrag mit leeren Feldern', () => {
  assert.equal(_isSelfCancelled({ beschreibung: '', empfehlung: '' }), false);
  assert.equal(_isSelfCancelled({}), false);
});

test('matcht case-insensitive', () => {
  assert.equal(_isSelfCancelled({ beschreibung: 'KEIN WIDERSPRUCH erkennbar.', empfehlung: '' }), true);
});

test('behält verneintes «nicht konsistent»/«nicht stimmig» in beschreibung', () => {
  assert.equal(_isSelfCancelled({ beschreibung: 'Das Geburtsjahr ist nicht konsistent mit Kapitel 2.', empfehlung: '' }), false);
  assert.equal(_isSelfCancelled({ beschreibung: 'Die Chronologie ist nicht stimmig.', empfehlung: '' }), false);
  assert.equal(_isSelfCancelled({ beschreibung: 'Die Angaben sind inkonsistent.', empfehlung: '' }), false);
});

test('behält Empfehlung, die ihr Ziel positiv formuliert («… konsistent bleibt»)', () => {
  assert.equal(_isSelfCancelled({
    beschreibung: 'Mareks Alter widerspricht sich zwischen Kapitel 2 und 5.',
    empfehlung: 'Alter in Kapitel 5 anpassen, damit die Zeitlinie konsistent bleibt und alles stimmig ist.',
  }), false);
});

// Verneinung mit Füllwörtern dazwischen ist KEINE Entwarnung — der Befund bleibt.
for (const beschreibung of [
  'Die Zeitlinie ist nicht mehr konsistent.',
  'Die Altersangaben sind nicht ganz stimmig.',
  'Das wirkt nicht so recht stimmig.',
  'Die Reihenfolge ist kaum wirklich in sich stimmig.',
  'Die Daten sind nicht zeitlich konsistent.',
]) {
  test(`behält verneinten Befund: «${beschreibung}»`, () => {
    assert.equal(_isSelfCancelled({ beschreibung, empfehlung: 'Angabe in Kapitel 3 anpassen.' }), false);
  });
}

test('droppt weiterhin positives «in sich konsistent»', () => {
  assert.equal(_isSelfCancelled({ beschreibung: 'Die Angaben sind in sich konsistent.' }), true);
});

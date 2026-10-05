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

// Adverbiales, verneintes oder lokal gebundenes «konsistent»/«kein Problem» ist KEINE
// Entwarnung; eine Empfehlung darf ihr Ziel als «kein Widerspruch» formulieren.
for (const [beschreibung, empfehlung] of [
  ['Marek spricht in Kapitel 1–6 konsistent Berlinerisch, in Kapitel 7 plötzlich Hochdeutsch.', 'Dialekt in Kapitel 7 beibehalten.'],
  ['Die Altersangaben sind nie konsistent.', ''],
  ['Die Altersangaben sind nicht durchgängig konsistent.', ''],
  ['Die Angaben sind weder vollständig noch konsistent.', ''],
  ['Das Geburtsjahr ist nicht konsistent mit Kapitel 2.', ''],
  ['The ages are not consistent.', ''],
  ['Marek stirbt in Kapitel 3 und lebt in Kapitel 5.', 'Tod abschwächen, damit kein Widerspruch entsteht.'],
  ['Lena hat ein gebrochenes Bein, doch der Sprint ist für sie kein Problem.', 'Verletzung früher heilen lassen.'],
]) {
  test(`behält echten Befund: «${beschreibung}» / «${empfehlung}»`, () => {
    assert.equal(_isSelfCancelled({ beschreibung, empfehlung }), false);
  });
}

for (const [beschreibung, empfehlung] of [
  ['No real contradiction – this is consistent with the flashback.', ''],
  ['Not a contradiction; the narrator lies.', ''],
  ['The dates are consistent.', ''],
  ['This can be explained by the time skip.', ''],
  ['Mareks Alter springt.', 'Remove this entry.'],
  ['Das ist kein wirklicher Widerspruch.', ''],
  ['Kein Problem. Die Reisezeit reicht aus.', ''],
  ['Die Chronologie ist insgesamt stimmig.', ''],
  ['Das Geburtsjahr ist konsistent mit Kapitel 2.', ''],
]) {
  test(`verwirft Selbst-Entwarnung: «${beschreibung}» / «${empfehlung}»`, () => {
    assert.equal(_isSelfCancelled({ beschreibung, empfehlung }), true);
  });
}

test('robust gegen Nicht-Objekte und Nicht-String-Felder', () => {
  assert.equal(_isSelfCancelled(null), false);
  assert.equal(_isSelfCancelled({ beschreibung: 42, empfehlung: ['x'] }), false);
});

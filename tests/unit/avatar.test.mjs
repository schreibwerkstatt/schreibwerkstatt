// Unit-Tests für die pure Avatar-Primitive (avatar.js, SSoT von
// app.userAvatarHue + Owner-Leiste + Share-Reader-Leiste). Reine Berechnung.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avatarHue, avatarInitials } from '../../public/js/avatar.js';

// Referenz-Implementierung = das frühere app-ui.js#userAvatarHue, gegen das wir
// Stabilität sichern (gleiche Person → gleiche Hue in Reader und SPA).
function legacyHue(email) {
  if (!email) return 0;
  const s = String(email).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

test('avatarHue: deterministisch im Bereich [0,360)', () => {
  for (const seed of ['anna@x.ch', 'Bob', 'café', 'anon']) {
    const h = avatarHue(seed);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
    assert.equal(avatarHue(seed), h); // stabil
  }
});

test('avatarHue: case-insensitiv (Email-/Namens-Schreibweise egal)', () => {
  assert.equal(avatarHue('Anna@X.CH'), avatarHue('anna@x.ch'));
});

test('avatarHue: leerer/fehlender Seed → 0', () => {
  assert.equal(avatarHue(''), 0);
  assert.equal(avatarHue(null), 0);
  assert.equal(avatarHue(undefined), 0);
});

test('avatarHue: identisch zur früheren userAvatarHue-Formel', () => {
  for (const seed of ['', 'me@host.tld', 'Erika Mustermann', 'x']) {
    assert.equal(avatarHue(seed), legacyHue(seed));
  }
});

test('avatarInitials: bis zu zwei Initialen, getrennt an Whitespace/._@-', () => {
  assert.equal(avatarInitials('Anna Schmidt'), 'AS');
  assert.equal(avatarInitials('anna.schmidt'), 'AS');
  assert.equal(avatarInitials('anna_schmidt@mail'), 'AS');
  assert.equal(avatarInitials('Bob'), 'B');
  assert.equal(avatarInitials('erika-mustermann'), 'EM');
});

test('avatarInitials: Klammern und Satzzeichen trennen, landen nie im Kürzel', () => {
  assert.equal(avatarInitials('Dev (lokal)'), 'DL');
  assert.equal(avatarInitials('«Leserin»'), 'L');
  assert.equal(avatarInitials('Zoë Müller'), 'ZM');
  assert.equal(avatarInitials('(—)'), '?');
});

test('avatarInitials: leer/ungültig → ?', () => {
  assert.equal(avatarInitials(''), '?');
  assert.equal(avatarInitials(null), '?');
  assert.equal(avatarInitials('   '), '?');
});

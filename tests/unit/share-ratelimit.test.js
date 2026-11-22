'use strict';
// lib/share-ratelimit.js: gleitendes Fenster je (Token, IP-Hash), Aufräumen
// abgelaufener Schlüssel, eigener Bucket für die Leseansicht.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');

useTmpDb('share-ratelimit');
require('../../db/migrations').runMigrations();
const rl = require('../../lib/share-ratelimit');

test('makeLimiter: Limit pro Schlüssel, Retry-After > 0', () => {
  const lim = rl.makeLimiter({ windowMs: () => 60_000, max: () => 3 });
  for (let i = 0; i < 3; i++) assert.equal(lim.check('tok', 'ip').allowed, true);
  const r = lim.check('tok', 'ip');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec >= 1);
  assert.equal(lim.check('tok', 'anderer').allowed, true, 'andere IP hat eigenen Bucket');
});

test('makeLimiter: abgelaufene Schlüssel fallen beim Aufräumen weg', () => {
  let win = 60_000;
  const lim = rl.makeLimiter({ windowMs: () => win, max: () => 5 });
  for (let i = 0; i < 50; i++) lim.check('tok', `ip${i}`);
  assert.equal(lim.size(), 50);
  win = -1; // alles gilt als abgelaufen
  lim.sweep();
  assert.equal(lim.size(), 0);
});

test('makeLimiter: räumt periodisch selbst auf (alle SWEEP_EVERY Aufrufe)', () => {
  let win = 60_000;
  const lim = rl.makeLimiter({ windowMs: () => win, max: () => 5 });
  for (let i = 0; i < 10; i++) lim.check('alt', `ip${i}`);
  win = 1; // ab jetzt sind die alten Einträge abgelaufen
  const start = Date.now();
  while (Date.now() - start < 3) { /* Fenster von 1 ms verstreichen lassen */ }
  for (let i = 10; i < rl.SWEEP_EVERY; i++) lim.check('neu', `ip${i}`);
  // Ohne Aufräumen stünden hier alle SWEEP_EVERY je gesehenen Schlüssel.
  assert.ok(lim.size() < rl.SWEEP_EVERY, `aufgeräumt (${lim.size()})`);
});

test('checkView: eigener Bucket, Deckel VIEW_MAX_PER_WINDOW', () => {
  rl._resetAll();
  for (let i = 0; i < rl.VIEW_MAX_PER_WINDOW; i++) assert.equal(rl.checkView('tok', 'ip').allowed, true);
  assert.equal(rl.checkView('tok', 'ip').allowed, false);
  assert.equal(rl.check('tok', 'ip').allowed, true, 'Kommentar-Bucket unberührt');
  rl._resetAll();
});

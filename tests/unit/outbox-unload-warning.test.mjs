// Warnung beim Schliessen (app/app-outbox.js#outboxWouldStrand): nur wenn
// Wartendes ohne offenen Tab liegen bliebe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outboxWouldStrand } from '../../public/js/app/app-outbox.js';

const base = { drafts: 0, queued: 0, unreachable: true, backgroundSync: false };

test('erreichbarer Server: nie warnen — die Outbox sendet gleich', () => {
  assert.equal(outboxWouldStrand({ ...base, drafts: 3, queued: 2, unreachable: false }), false);
});

test('nichts wartend: nicht warnen', () => {
  assert.equal(outboxWouldStrand(base), false);
});

test('Entwürfe ohne Background Sync (Firefox, Safari): warnen', () => {
  assert.equal(outboxWouldStrand({ ...base, drafts: 1 }), true);
});

test('Entwürfe mit Background Sync (Chromium): nicht warnen — der Service Worker sendet', () => {
  assert.equal(outboxWouldStrand({ ...base, drafts: 1, backgroundSync: true }), false);
});

test('Struktur-/Ideen-Warteschlange: auch mit Background Sync warnen', () => {
  assert.equal(outboxWouldStrand({ ...base, queued: 1, backgroundSync: true }), true);
});

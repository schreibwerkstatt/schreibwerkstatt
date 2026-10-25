'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Eigene Test-DB pro Lauf, sonst kollidiert das Test-Statement-Cache mit
// anderen Test-Suites, die parallel laufen (--test-concurrency=4).
const { useTmpDb } = require('./_helpers/tmp-db');
const tmp = useTmpDb('pdfx-db');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');

test('CRUD-Cycle für pdf_export_profile', () => {
  const userA = 'a@x.test';
  const userB = 'b@x.test';

  // Mig 130 FK: user_email braucht app_users-Row.
  appUsers.createUser({ email: userA, displayName: 'A' });
  appUsers.createUser({ email: userB, displayName: 'B' });

  // Mig 81: pdf_export_profile.book_id FK -> books(bookstack_book_id).
  // Test-Buch im books-Cache anlegen.
  schema.upsertBookByName(42, 'Test-Buch 42');

  const p1 = schema.createPdfExportProfile(42, userA, 'A4 Print', { layout: { pageSize: 'A4' } });
  assert.ok(p1.id);
  assert.equal(p1.is_default, false);
  assert.equal(p1.has_back_cover, false);

  const p2 = schema.createPdfExportProfile(42, userA, 'A5 Pocket', { layout: { pageSize: 'A5' } });
  const list = schema.listPdfExportProfiles(42, userA);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'A4 Print');     // alphabetisch nach is_default DESC

  // User B sieht NICHT die Profile von User A.
  assert.equal(schema.listPdfExportProfiles(42, userB).length, 0);

  // setDefault macht genau eines zum Default.
  schema.setPdfExportProfileDefault(42, userA, p2.id);
  const after = schema.listPdfExportProfiles(42, userA);
  const defs = after.filter(p => p.is_default);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].id, p2.id);

  // Umschlag-Rückseitenbild setzen + lesen + löschen (profil-gebunden, Phase-4-Cover-PDF).
  // Front-Cover + Autorfoto leben buch-weit in book_publication, nicht mehr am Profil.
  const buf = Buffer.from('FAKEJPEG');
  schema.setPdfExportProfileBackCover(p1.id, buf, 'image/jpeg');
  const back = schema.getPdfExportProfileBackCover(p1.id);
  assert.ok(back);
  assert.equal(back.mime, 'image/jpeg');
  assert.equal(back.image.toString(), 'FAKEJPEG');

  schema.clearPdfExportProfileBackCover(p1.id);
  assert.equal(schema.getPdfExportProfileBackCover(p1.id), null);

  // Update + Delete
  schema.updatePdfExportProfile(p1.id, 'A4 Final', { layout: { pageSize: 'A4', columns: 2 } });
  const updated = schema.getPdfExportProfile(p1.id);
  assert.equal(updated.name, 'A4 Final');
  assert.equal(updated.config.layout.columns, 2);

  schema.deletePdfExportProfile(p1.id);
  assert.equal(schema.getPdfExportProfile(p1.id), null);
});

test('Font-Cache schreibt Buffer und liefert Frische-Indikator', () => {
  schema.cacheFont('Lora', 400, 'normal', Buffer.from([0,1,0,0]));
  const hit = schema.getCachedFont('Lora', 400, 'normal');
  assert.ok(hit);
  assert.equal(hit.stale, false);
  assert.equal(hit.ttf[0], 0);
  assert.equal(hit.ttf[1], 1);
});

test('Font-Cache miss liefert null', () => {
  const miss = schema.getCachedFont('Nichts', 999, 'normal');
  assert.equal(miss, null);
});


test('Timestamps sind ISO+Z; korrupte config_json bricht weder Get noch Listing', () => {
  const user = 'c@x.test';
  appUsers.createUser({ email: user, displayName: 'C' });
  const p = schema.createPdfExportProfile(0, user, 'Kaputt', {});
  assert.match(String(p.created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(String(p.updated_at), /Z$/);

  const { db } = require('../../db/connection');
  db.prepare('UPDATE pdf_export_profile SET config_json = ? WHERE id = ?').run('{nicht json', p.id);
  const { defaultConfig } = require('../../lib/pdf-export-defaults');
  const got = schema.getPdfExportProfile(p.id);
  assert.deepEqual(got.config, defaultConfig());
  const list = schema.listPdfExportProfiles(0, user);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, p.id);
});

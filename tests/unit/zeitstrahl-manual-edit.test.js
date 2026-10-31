'use strict';
// Vom Autor bearbeitete Zeitstrahl-Ereignisse überleben die Komplettanalyse
// (zeitstrahl_events.manually_edited / ki_key — Migration 347), und die Analyse
// legt ihr eigenes Ereignis nicht ein zweites Mal daneben. Dazu: Anker-IDs aus
// dem Aufrufer (P6) gelten vor der Namensauflösung — ein Name, den zwei Kapitel
// tragen, kostet das Ereignis seinen Kapitelbezug sonst.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('zeitstrahl-manual-edit');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { saveZeitstrahlEvents } = require('../../db/zeitstrahl');
const { validateEventPatch, patchZeitstrahlEvent } = require('../../db/zeitstrahl-patch');
const { eventModel } = require('../../lib/esm-bridge');

const BOOK = 5201;
const USER = 'autor@x.ch';
let groupKey;

test.before(async () => {
  ({ eventGroupKey: groupKey } = await eventModel());
  const now = new Date().toISOString();
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  const ch = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)');
  ch.run(9201, BOOK, 'Einleitung', 0, now);
  ch.run(9202, BOOK, 'Einleitung', 1, now);
});

const _rows = () => db.prepare('SELECT * FROM zeitstrahl_events WHERE book_id = ? ORDER BY id').all(BOOK);
const _lauf = (events) => saveZeitstrahlEvents(BOOK, USER, events, {}, null, { groupKey });

const KI = [
  { datum_label: '1985', datum_year: 1985, ereignis: 'Anna zieht nach Bern', typ: 'persoenlich', subtyp: 'umzug' },
  { datum_label: '1990', datum_year: 1990, ereignis: 'Hochzeit', typ: 'persoenlich', subtyp: 'hochzeit' },
];

test('Bearbeiten setzt manually_edited, sichert ki_key und parst das Datum', () => {
  _lauf(KI);
  const anna = _rows().find(r => r.ereignis === 'Anna zieht nach Bern');
  const { fields } = validateEventPatch({ fields: { ereignis: 'Anna zieht nach Basel', datum_label: 'ca. 1986' } });
  const r = patchZeitstrahlEvent(BOOK, USER, anna.id, fields, groupKey);
  assert.deepEqual(r.changed.sort(), ['datum_label', 'ereignis']);
  const after = _rows().find(x => x.id === anna.id);
  assert.equal(after.manually_edited, 1);
  assert.equal(after.ki_key, groupKey(anna), 'ki_key = Schlüssel des KI-Stands');
  assert.equal(after.datum_year, 1986);
  assert.equal(after.datum_unsicher, 1, '«ca.» markiert das Jahr als unsicher');
});

test('Nächster Lauf: gepflegte Zeile bleibt, kein KI-Doppel', () => {
  _lauf(KI);
  const rows = _rows();
  assert.equal(rows.filter(r => /Anna/.test(r.ereignis)).length, 1);
  assert.equal(rows.find(r => /Anna/.test(r.ereignis)).ereignis, 'Anna zieht nach Basel');
  assert.equal(rows.filter(r => r.ereignis === 'Hochzeit').length, 1);
});

test('Zweites Bearbeiten lässt ki_key stehen', () => {
  const anna = _rows().find(r => /Anna/.test(r.ereignis));
  const before = anna.ki_key;
  const { fields } = validateEventPatch({ fields: { bedeutung: 'Neuanfang' } });
  patchZeitstrahlEvent(BOOK, USER, anna.id, fields, groupKey);
  assert.equal(_rows().find(r => r.id === anna.id).ki_key, before);
});

test('Validierung: leerer Text, unbekanntes Feld, ungültiger Subtyp', () => {
  assert.equal(validateEventPatch({ fields: { ereignis: '  ' } }).error.error_code, 'EVENT_TEXT_REQUIRED');
  assert.equal(validateEventPatch({ fields: { sort_order: '1' } }).error.reason, 'unknown');
  assert.equal(validateEventPatch({ fields: { subtyp: 'erfunden' } }).error.field, 'subtyp');
  assert.equal(validateEventPatch({ fields: {} }).error.reason, 'empty');
});

test('Fremdes Buch/Ereignis → null', () => {
  const { fields } = validateEventPatch({ fields: { ereignis: 'x' } });
  assert.equal(patchZeitstrahlEvent(BOOK + 1, USER, _rows()[0].id, fields, groupKey), null);
});

test('Anker-IDs des Aufrufers gelten bei gleichnamigen Kapiteln', () => {
  saveZeitstrahlEvents(BOOK, USER, [
    { datum_label: '2001', datum_year: 2001, ereignis: 'Abschied', kapitel: ['Einleitung'], chapter_ids: [9202] },
  ], { }, null, { groupKey });
  const ev = _rows().find(r => r.ereignis === 'Abschied');
  const chapters = db.prepare('SELECT chapter_id FROM zeitstrahl_event_chapters WHERE event_id = ?').all(ev.id);
  assert.deepEqual(chapters.map(c => c.chapter_id), [9202]);
});

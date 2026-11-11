'use strict';
// db/locations-write.js#patchOrtCoords — Koordinaten-Patch der Geo-Karte
// (Marker-Drag, Undo/Redo, Georeferenz löschen).
//   * Längengrad jenseits der Datumsgrenze (Leaflet-Welt-Kopie) wird umgerechnet,
//     nicht auf ±180 geklemmt.
//   * Jeder Patch ist eine Hand-Entscheidung → KI-Herkunft (geo_query/geo_land) weg.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('location-coords-patch');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { patchOrtCoords, _lng } = require('../../db/locations-write');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();

function seed() {
  const bookId = 8811;
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch', NOW, NOW, USER);
  db.prepare('DELETE FROM locations WHERE book_id = ?').run(bookId);
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, lat, lng, geo_query, geo_land, updated_at)
              VALUES (?, 'ort_1', 'Badi Olten', ?, 47.35, 7.9, 'Olten', 'ch', ?)`).run(bookId, USER, NOW);
  return bookId;
}

const row = (bookId) => db.prepare(
  "SELECT lat, lng, geo_query, geo_land FROM locations WHERE book_id = ? AND loc_id = 'ort_1'"
).get(bookId);

test('_lng: Hauptwelt bleibt, Welt-Kopien werden umgerechnet', () => {
  assert.equal(_lng(7.9), 7.9);
  assert.equal(_lng(-180), -180);
  assert.equal(_lng(190), -170);
  assert.equal(_lng(-190), 170);
  assert.equal(_lng(540), -180);
  assert.equal(_lng(''), null);
  assert.equal(_lng('x'), null);
});

test('patchOrtCoords: Drag über die Datumsgrenze speichert den gemeinten Punkt', () => {
  const bookId = seed();
  assert.equal(patchOrtCoords(bookId, [{ id: 'ort_1', lat: 95, lng: 190 }], USER), 1);
  const r = row(bookId);
  assert.equal(r.lat, 90);
  assert.equal(r.lng, -170);
});

test('patchOrtCoords: Verschieben nullt die KI-Herkunft', () => {
  const bookId = seed();
  patchOrtCoords(bookId, [{ id: 'ort_1', lat: 47.4, lng: 8.0 }], USER);
  const r = row(bookId);
  assert.equal(r.lat, 47.4);
  assert.equal(r.geo_query, null);
  assert.equal(r.geo_land, null);
});

test('patchOrtCoords: Löschen nullt Koordinaten und KI-Herkunft', () => {
  const bookId = seed();
  patchOrtCoords(bookId, [{ id: 'ort_1', lat: null, lng: null }], USER);
  assert.deepEqual({ ...row(bookId) }, { lat: null, lng: null, geo_query: null, geo_land: null });
});

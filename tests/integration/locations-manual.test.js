'use strict';
// Schauplätze: manuelle Pflege (POST/PATCH/DELETE /locations) und wie die
// Komplettanalyse (saveOrteToDb matchBy:'name') sie respektiert — docs/schauplaetze.md.
//
// Kern der Sache:
//  - Koordinaten überleben eine Re-Analyse auch dann, wenn der Abgleich den Ort über
//    eine NAMENSVARIANTE zuordnet (vorher gingen die Pins dabei still verloren).
//  - Vom Autor korrigierte Stammdaten überschreibt die Analyse nicht; ein umbenannter
//    Ort wird über seinen Textnamen (ki_name) weiter gefunden.
//  - Selbst angelegte Orte werden nie «nicht mehr im Text».
//  - Haeufigkeit kommt aus den Szenen, nicht als konstante 1 aus der KI-Liste.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bootstrap } = require('./_helpers/setup');

const USER = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
const ANALYSE = { matchBy: 'name', onMissing: 'stale', preserveExistingCoords: true };
let ctx, db, dbSchema, server, baseUrl, seq = 0;

test.before(async () => {
  ctx = bootstrap();
  dbSchema = require('../../db/schema');
  db = dbSchema.db;
  await new Promise((resolve) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: USER } }; next(); });
    app.use('/locations', require('../../routes/locations'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { server?.close(); ctx.cleanup(); });

function newBook() {
  const bookId = 9600 + (++seq);
  const { grantAccess } = require('../../db/book-access');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(bookId, NOW, NOW);
  grantAccess(bookId, USER, 'editor', USER);
  return bookId;
}

async function api(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const row = (bookId, where, ...args) =>
  db.prepare(`SELECT * FROM locations WHERE book_id = ? AND ${where}`).get(bookId, ...args);

// ── Analyse-Schreibpfad ─────────────────────────────────────────────────────

test('Re-Analyse mit Namensvariante behält Koordinaten, Land und Geocode-Cache', () => {
  const book = newBook();
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Schulhaus Frohheim', land: 'ch' }], USER, {}, {}, ANALYSE);
  const id = row(book, "loc_id = 'ort_1'").id;
  db.prepare("UPDATE locations SET lat = 47.35, lng = 7.9, geo_query = 'Olten', geo_land = 'ch' WHERE id = ?").run(id);

  // Der Judge hat die Variante als denselben Ort bestätigt (matchHint: loc_id → id).
  dbSchema.saveOrteToDb(book, [{ id: 'ort_7', name: 'Frohheim-Schule Olten' }], USER, {}, {},
    { ...ANALYSE, matchHint: new Map([['ort_7', id]]) });

  const r = row(book, 'id = ?', id);
  assert.equal(r.name, 'Frohheim-Schule Olten');
  assert.equal(r.lat, 47.35, 'Pin bleibt trotz neuer Schreibweise');
  assert.equal(r.lng, 7.9);
  assert.equal(r.land, 'ch');
  assert.equal(r.geo_query, 'Olten', 'Abgleich sagt «derselbe Ort» → Resolve-Cache bleibt');
});

test('Vom Autor korrigierte Felder überleben die Analyse, Umbenennung matcht über ki_name', async () => {
  const book = newBook();
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Burg Falkenstein', typ: 'gebaeude', beschreibung: 'KI-Text' }], USER, {}, {}, ANALYSE);
  const id = row(book, "loc_id = 'ort_1'").id;

  const p = await api('PATCH', `/locations/${book}/ort_1`, { name: 'Die Feste', beschreibung: 'Meine Beschreibung', typ: 'region' });
  assert.equal(p.status, 200);

  dbSchema.saveOrteToDb(book, [{ id: 'ort_3', name: 'Burg Falkenstein', typ: 'gebaeude', beschreibung: 'neuer KI-Text' }], USER, {}, {}, ANALYSE);

  const r = row(book, 'id = ?', id);
  assert.equal(r.stale, 0, 'umbenannter Ort wird über den Textnamen gefunden, nicht verwaist');
  assert.equal(r.name, 'Die Feste');
  assert.equal(r.beschreibung, 'Meine Beschreibung');
  assert.equal(r.typ, 'region');
  assert.equal(r.ki_name, 'Burg Falkenstein');
  assert.equal(r.manually_edited, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM locations WHERE book_id = ?').get(book).n, 1, 'keine Dublette');
});

test('Selbst angelegter Ort wird nie stale und räumt den ort_N-Namespace', async () => {
  const book = newBook();
  const c = await api('POST', `/locations/${book}`, { name: 'Café Mira', typ: 'gebaeude', land: 'CH' });
  assert.equal(c.status, 200);
  assert.match(c.json.id, /^man_\d+$/);

  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Bahnhof' }], USER, {}, {}, ANALYSE);

  const r = row(book, 'loc_id = ?', c.json.id);
  assert.equal(r.stale, 0);
  assert.equal(r.land, 'ch');
  assert.equal(r.manually_created, 1);
});

test('Haeufigkeit je Kapitel kommt aus den Szenen (MAX, nie absenken)', () => {
  const book = newBook();
  const ch = 97000 + seq;
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)').run(ch, book, 'Kapitel 1', NOW);
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Hafen', kapitel: ['Kapitel 1'] }], USER, { 'Kapitel 1': ch }, {}, ANALYSE);
  const loc = row(book, "loc_id = 'ort_1'").id;
  for (const titel of ['A', 'B', 'C']) {
    const sid = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(book, USER, titel, ch, NOW).lastInsertRowid;
    db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(sid, loc);
  }
  dbSchema.backfillLocationChaptersFromScenes(book, USER);
  const h = () => db.prepare('SELECT haeufigkeit h FROM location_chapters WHERE location_id = ?').get(loc).h;
  assert.equal(h(), 3);
  db.prepare('UPDATE location_chapters SET haeufigkeit = 5 WHERE location_id = ?').run(loc);
  dbSchema.backfillLocationChaptersFromScenes(book, USER);
  assert.equal(h(), 5, 'höherer Bestandswert bleibt');
});

// ── Pflege-Routen ───────────────────────────────────────────────────────────

test('Hierarchie: Elternort setzen, GET liefert parent, Zyklus → 409', async () => {
  const book = newBook();
  const stadt = (await api('POST', `/locations/${book}`, { name: 'Olten' })).json.id;
  const hotel = (await api('POST', `/locations/${book}`, { name: 'Hotel Krone', parent: stadt })).json.id;
  const zimmer = (await api('POST', `/locations/${book}`, { name: 'Zimmer 12', parent: hotel })).json.id;

  const list = (await api('GET', `/locations/${book}`)).json.orte;
  assert.equal(list.find(o => o.id === zimmer).parent, hotel);
  assert.equal(list.find(o => o.id === stadt).parent, null);

  const cyc = await api('PATCH', `/locations/${book}/${stadt}`, { parent: zimmer });
  assert.equal(cyc.status, 409);
  assert.equal(cyc.json.error_code, 'PARENT_CYCLE');
  const self = await api('PATCH', `/locations/${book}/${hotel}`, { parent: hotel });
  assert.equal(self.json.error_code, 'PARENT_CYCLE');

  // Elternort löschen → Kind fällt auf die Wurzel zurück (SET NULL).
  assert.equal((await api('DELETE', `/locations/${book}/${hotel}`)).status, 200);
  assert.equal(row(book, 'loc_id = ?', zimmer).parent_id, null);
});

test('PATCH validiert: leerer Name, ungültiges Land, fremder Ort', async () => {
  const book = newBook();
  const id = (await api('POST', `/locations/${book}`, { name: 'Bahnhof' })).json.id;
  assert.equal((await api('PATCH', `/locations/${book}/${id}`, { name: '  ' })).json.error_code, 'NAME_REQUIRED');
  assert.equal((await api('PATCH', `/locations/${book}/${id}`, { land: 'Schweiz' })).json.error_code, 'INVALID_LAND');
  assert.equal((await api('PATCH', `/locations/${book}/nope`, { name: 'x' })).status, 404);
  assert.equal((await api('POST', `/locations/${book}`, {})).json.error_code, 'NAME_REQUIRED');
});

test('Umbenennen nullt den Geocode-Cache, Koordinaten bleiben', async () => {
  const book = newBook();
  const id = (await api('POST', `/locations/${book}`, { name: 'Badi' })).json.id;
  db.prepare("UPDATE locations SET lat = 1, lng = 2, geo_query = 'Olten' WHERE loc_id = ?").run(id);
  await api('PATCH', `/locations/${book}/${id}`, { name: 'Badi Olten' });
  const r = row(book, 'loc_id = ?', id);
  assert.equal(r.geo_query, null);
  assert.equal(r.lat, 1);
});

test('Ganzer Katalog lässt sich nicht mehr per PUT ersetzen', async () => {
  const book = newBook();
  const r = await api('PUT', `/locations/${book}`, { orte: [] });
  assert.equal(r.status, 404);
});

// ── Feld-Schutz, Wiederherstellen, Aliase ───────────────────────────────────

test('Feld-Schutz: nur geänderte Felder, Elternort allein schützt nichts', async () => {
  const book = newBook();
  dbSchema.saveOrteToDb(book, [
    { id: 'ort_1', name: 'Olten', typ: 'stadt', beschreibung: 'KI Olten' },
    { id: 'ort_2', name: 'Hotel Krone', typ: 'gebaeude', beschreibung: 'KI alt', stimmung: 'ruhig' },
  ], USER, {}, {}, ANALYSE);

  // Elternort + unverändert mitgeschickte Felder → kein Schutz.
  const p1 = await api('PATCH', `/locations/${book}/ort_2`, { parent: 'ort_1', name: 'Hotel Krone', typ: 'gebaeude' });
  assert.equal(p1.json.changed, true);
  let r = row(book, "name = 'Hotel Krone'");
  assert.equal(r.manually_edited, 0);
  assert.equal(r.manual_fields, null);

  // Nur die Beschreibung geändert → nur sie ist geschützt.
  await api('PATCH', `/locations/${book}/ort_2`, { beschreibung: 'Meine Krone' });
  r = row(book, 'id = ?', r.id);
  assert.deepEqual(JSON.parse(r.manual_fields), ['beschreibung']);
  assert.equal(r.manually_edited, 1);
  assert.equal(r.ki_beschreibung, 'KI alt', 'Analysewert gesichert');

  dbSchema.saveOrteToDb(book, [
    { id: 'ort_1', name: 'Olten', typ: 'stadt' },
    { id: 'ort_2', name: 'Hotel Krone', typ: 'gebaeude', beschreibung: 'KI neu', stimmung: 'laut' },
  ], USER, {}, {}, ANALYSE);
  r = row(book, 'id = ?', r.id);
  assert.equal(r.beschreibung, 'Meine Krone', 'geschütztes Feld bleibt');
  assert.equal(r.stimmung, 'laut', 'ungeschütztes Feld folgt der Analyse');
  assert.equal(r.ki_beschreibung, 'KI neu');
  assert.ok(r.parent_id, 'Hierarchie bleibt');

  // Gleicher Wert erneut → nichts geändert.
  const p3 = await api('PATCH', `/locations/${book}/${r.loc_id}`, { beschreibung: 'Meine Krone' });
  assert.equal(p3.json.changed, false);
});

test('Analyse-Werte übernehmen: Schutz weg, Analysewert zurück; selbst angelegt → 409', async () => {
  const book = newBook();
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Burg', typ: 'gebaeude', beschreibung: 'KI-Text' }], USER, {}, {}, ANALYSE);
  await api('PATCH', `/locations/${book}/ort_1`, { name: 'Die Feste', beschreibung: 'Meins' });
  const list = (await api('GET', `/locations/${book}`)).json.orte;
  assert.deepEqual(list[0].manual_fields, ['name', 'beschreibung']);
  assert.equal(list[0].analysis_known, true);

  const res = await api('POST', `/locations/${book}/ort_1/restore-analysis`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.restored.sort(), ['beschreibung', 'name']);
  const r = row(book, "loc_id = 'ort_1'");
  assert.equal(r.name, 'Burg');
  assert.equal(r.beschreibung, 'KI-Text');
  assert.equal(r.manual_fields, null);
  assert.equal(r.manually_edited, 0);

  const man = (await api('POST', `/locations/${book}`, { name: 'Café' })).json.id;
  const no = await api('POST', `/locations/${book}/${man}/restore-analysis`, {});
  assert.equal(no.status, 409);
  assert.equal(no.json.error_code, 'NO_ANALYSIS');
});

test('Selbst angelegter Ort, den die Analyse findet: Flag weg, Stammdaten bleiben', async () => {
  const book = newBook();
  const id = (await api('POST', `/locations/${book}`, { name: 'Café Mira', beschreibung: 'Meins' })).json.id;
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Café Mira', beschreibung: 'KI' }], USER, {}, {}, ANALYSE);
  const r = row(book, "name = 'Café Mira'");
  assert.equal(r.loc_id, 'ort_1');
  assert.equal(r.manually_created, 0, 'jetzt ein Analyse-Ort');
  assert.equal(r.beschreibung, 'Meins', 'Autorentext bleibt geschützt');
  assert.equal(r.ki_beschreibung, 'KI');
  // Verschwindet er aus dem Text, wird er wie jeder Analyse-Ort verwaist.
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Bahnhof' }], USER, {}, {}, ANALYSE);
  assert.equal(row(book, 'id = ?', r.id).stale, 1);
});

test('Selbst angelegte Orte reihen sich hinter die Analyse-Orte', async () => {
  const book = newBook();
  await api('POST', `/locations/${book}`, { name: 'Café' });
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'A' }, { id: 'ort_2', name: 'B' }], USER, {}, {}, ANALYSE);
  const names = db.prepare('SELECT name FROM locations WHERE book_id = ? ORDER BY sort_order, id').all(book).map(r => r.name);
  assert.deepEqual(names, ['A', 'B', 'Café']);
});

test('Merge: verwaistes Ziel → 409; Quellname wird Alias, nächste Analyse legt ihn nicht neu an', async () => {
  const book = newBook();
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Schulhaus Frohheim' }, { id: 'ort_2', name: 'Frohheimschule' }], USER, {}, {}, ANALYSE);
  // ort_2 verschwindet → verwaist (loc_id orphan_<id>).
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Schulhaus Frohheim' }, { id: 'ort_9', name: 'Bahnhof' }], USER, {}, {}, ANALYSE);
  const stale = row(book, "name = 'Frohheimschule'");
  assert.equal(stale.stale, 1);
  const bad = await api('POST', `/locations/${book}/merge`, { source: 'ort_1', target: stale.loc_id });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error_code, 'TARGET_STALE');

  const ok = await api('POST', `/locations/${book}/merge`, { source: stale.loc_id, target: 'ort_1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.aliasesAdded, ['Frohheimschule']);

  dbSchema.saveOrteToDb(book, [
    { id: 'ort_1', name: 'Schulhaus Frohheim' }, { id: 'ort_2', name: 'Frohheimschule' }, { id: 'ort_3', name: 'Bahnhof' },
  ], USER, {}, {}, ANALYSE);
  const all = db.prepare('SELECT name, stale FROM locations WHERE book_id = ? ORDER BY id').all(book);
  assert.equal(all.filter(r => r.name === 'Frohheimschule').length, 0, 'keine neue Zeile für den Alias');
  assert.equal(all.length, 2);
});

test('Kollaps-Zählung ignoriert nie gefundene, selbst angelegte Orte', async () => {
  const { countActiveLocations } = require('../../db/katalog-anker');
  const book = newBook();
  for (const n of ['A', 'B', 'C']) await api('POST', `/locations/${book}`, { name: n });
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Hafen' }, { id: 'ort_2', name: 'A' }], USER, {}, {}, ANALYSE);
  assert.equal(countActiveLocations(book, USER), 2, 'Hafen + der gefundene «A»');
});

test('locationParentMap ist pro User: gleiche loc_id zweier Analysen kollidiert nicht', async () => {
  const { locationParentMap } = require('../../db/locations-read');
  const book = newBook();
  const OTHER = 'zweit@test.dev';
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(OTHER, 'Z');
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Olten' }, { id: 'ort_2', name: 'Krone' }], USER, {}, {}, ANALYSE);
  dbSchema.saveOrteToDb(book, [{ id: 'ort_1', name: 'Bern' }, { id: 'ort_2', name: 'Bär' }], OTHER, {}, {}, ANALYSE);
  await api('PATCH', `/locations/${book}/ort_2`, { parent: 'ort_1' });
  assert.equal(locationParentMap(book, USER).get('ort_2'), 'ort_1');
  assert.equal(locationParentMap(book, OTHER).size, 0);
});

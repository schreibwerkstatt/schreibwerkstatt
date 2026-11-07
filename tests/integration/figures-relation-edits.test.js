'use strict';
// Integration: Korrekturen des Autors an Figuren-Beziehungen überleben die nächste
// Komplettanalyse (db/figures/relation-edits.js, db/figures/save.js#_writeRelations).
//   - DELETE /figures/:book_id/relations/:rel_id: eine KI-Kante bekommt eine
//     Löschmarke, der nächste Analyselauf legt sie nicht wieder an.
//   - PATCH … { to }: die Kante zeigt aufs neue Ziel, wird 'manual' und sperrt ihr
//     Paar; die alte KI-Fassung ist markiert.
//   - Eine manuelle Kante sperrt das Paar auch gegen KI-Kanten ANDEREN Typs.
//   - Der dritte Schreibpfad (addFigurenBeziehungen, kapitelübergreifend) respektiert
//     die Löschmarke.
// Prod-Fall «Der Amoklauf»: Stefan –elternteil→ Adrian (Kopie der Peter-Kante),
// Reto –elternteil→ Stefanies Mutter (statt Retos Vater).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'reledit-autor@test.dev';
const OTHER = 'reledit-fremd@test.dev';
const BOOK = 9521;
const NOW = '2026-01-01T00:00:00.000Z';

let server; let baseUrl; let db;

async function call(method, path, body, user = ME) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'x-test-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Ein Analyselauf mit festen Kanten (wie die Komplettanalyse ihn speichert).
function analyse() {
  const { saveFigurenToDb } = require('../../db/figures');
  saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Stefan', typ: 'hauptfigur', beziehungen: [
      { figur_id: 'fig_2', typ: 'elternteil', beschreibung: 'Der Vater.' },
      { figur_id: 'fig_3', typ: 'elternteil', beschreibung: 'Der Vater.' },
    ] },
    { id: 'fig_2', name: 'Peter', typ: 'nebenfigur' },
    { id: 'fig_3', name: 'Adrian', typ: 'nebenfigur' },
    { id: 'fig_4', name: 'Reto', typ: 'nebenfigur', beziehungen: [
      { figur_id: 'fig_5', typ: 'elternteil', beschreibung: 'Der Vater baut ihm die Mini-Pipe.' },
    ] },
    { id: 'fig_5', name: 'Stefanies Mutter', typ: 'randfigur' },
    { id: 'fig_6', name: 'Retos Vater', typ: 'randfigur' },
  ], ME, {}, { reconcile: true, onMissing: 'stale' });
}

function rels() {
  return db.prepare(`
    SELECT r.id, ff.name AS von, ft.name AS zu, r.typ, r.origin
      FROM figure_relations r
      JOIN figures ff ON ff.id = r.from_fig_id
      JOIN figures ft ON ft.id = r.to_fig_id
     WHERE r.book_id = ? AND r.user_email = ?
     ORDER BY ff.name, ft.name`).all(BOOK, ME);
}
const relId = (von, zu) => rels().find(r => r.von === von && r.zu === zu)?.id;
const has = (von, zu) => rels().some(r => r.von === von && r.zu === zu);

test.before(async () => {
  bootstrap();
  ({ db } = require('../../db/schema'));
  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Buch', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  analyse();

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/figures', require('../../routes/figures'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('GET liefert rel_id je Beziehung', async () => {
  const r = await call('GET', `/figures/${BOOK}`);
  const stefan = r.body.figuren.find(f => f.name === 'Stefan');
  assert.ok(stefan.beziehungen.every(b => Number.isInteger(b.rel_id)));
});

test('DELETE einer KI-Kante: weg, und die nächste Analyse legt sie nicht wieder an', async () => {
  const id = relId('Stefan', 'Adrian');
  assert.ok(id);
  const r = await call('DELETE', `/figures/${BOOK}/relations/${id}`);
  assert.equal(r.status, 200);
  assert.ok(!has('Stefan', 'Adrian'));
  analyse();
  assert.ok(!has('Stefan', 'Adrian'), 'Löschmarke hält');
  assert.ok(has('Stefan', 'Peter'), 'die richtige Kante bleibt');
});

test('PATCH umhängen: neues Ziel, manual, alte Fassung kommt nicht zurück', async () => {
  const id = relId('Reto', 'Stefanies Mutter');
  const fig6 = db.prepare("SELECT fig_id FROM figures WHERE book_id = ? AND name = 'Retos Vater'").get(BOOK).fig_id;
  const r = await call('PATCH', `/figures/${BOOK}/relations/${id}`, { to: fig6 });
  assert.equal(r.status, 200);
  const moved = rels().find(x => x.von === 'Reto' && x.zu === 'Retos Vater');
  assert.equal(moved?.origin, 'manual');
  analyse();
  assert.ok(!has('Reto', 'Stefanies Mutter'), 'alte KI-Fassung bleibt verworfen');
  assert.equal(rels().filter(x => x.von === 'Reto').length, 1);
});

test('manuelle Kante sperrt ihr Paar auch gegen KI-Kanten anderen Typs', () => {
  const ids = Object.fromEntries(db.prepare('SELECT name, id FROM figures WHERE book_id = ?').all(BOOK).map(f => [f.name, f.id]));
  db.prepare("UPDATE figure_relations SET typ = 'geschwister', origin = 'manual' WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ?")
    .run(BOOK, ids.Stefan, ids.Peter);
  analyse();
  const pair = rels().filter(x => x.von === 'Stefan' && x.zu === 'Peter');
  assert.deepEqual(pair.map(x => `${x.typ}:${x.origin}`), ['geschwister:manual']);
});

test('addFigurenBeziehungen (kapitelübergreifend) respektiert die Löschmarke', () => {
  const { addFigurenBeziehungen } = require('../../db/figures');
  const figId = (name) => db.prepare('SELECT fig_id FROM figures WHERE book_id = ? AND name = ?').get(BOOK, name).fig_id;
  addFigurenBeziehungen(BOOK, [{ von: figId('Stefan'), zu: figId('Adrian'), typ: 'elternteil', beschreibung: 'x' }], ME, {});
  assert.ok(!has('Stefan', 'Adrian'));
  // Dieselbe Aussage aus der Gegenperspektive (Adrian –kind→ Stefan) ist dieselbe Marke.
  addFigurenBeziehungen(BOOK, [{ von: figId('Adrian'), zu: figId('Stefan'), typ: 'kind', beschreibung: 'x' }], ME, {});
  assert.ok(!has('Adrian', 'Stefan'));
});

test('Fehlerfälle: fremde/unbekannte Kante 404, Selbstbezug 400, ohne Ziel 400', async () => {
  const id = relId('Stefan', 'Peter');
  assert.equal((await call('DELETE', `/figures/${BOOK}/relations/999999`)).status, 404);
  assert.equal((await call('DELETE', `/figures/${BOOK}/relations/${id}`, null, OTHER)).status, 403);
  const stefan = db.prepare("SELECT fig_id FROM figures WHERE book_id = ? AND name = 'Stefan'").get(BOOK).fig_id;
  const self = await call('PATCH', `/figures/${BOOK}/relations/${id}`, { to: stefan });
  assert.equal(self.status, 400);
  assert.equal(self.body.error_code, 'SELF_RELATION');
  assert.equal((await call('PATCH', `/figures/${BOOK}/relations/${id}`, {})).status, 400);
  assert.equal((await call('PATCH', `/figures/${BOOK}/relations/${id}`, { to: 'fig_nope' })).status, 404);
});

test('.swbook: Löschmarken reisen mit und wirken im Zielbuch', () => {
  const { collectExtras, restoreExtras } = require('../../db/book-migration-data');
  const TARGET = 9522;
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(TARGET, 'Kopie', NOW, NOW, ME);
  const extras = collectExtras(BOOK, { analysis: true }, ME);
  assert.ok(extras.analysis.figureRelationSuppressions.length >= 2);
  restoreExtras(TARGET, extras, {}, ME);
  const n = db.prepare('SELECT COUNT(*) AS n FROM figure_relation_suppressions WHERE book_id = ? AND user_email = ?').get(TARGET, ME).n;
  assert.equal(n, extras.analysis.figureRelationSuppressions.length);
  // Ein Analyselauf im Zielbuch legt die verworfene Kante nicht wieder an.
  const { saveFigurenToDb } = require('../../db/figures');
  saveFigurenToDb(TARGET, [
    { id: 'fig_1', name: 'Stefan', typ: 'hauptfigur', beziehungen: [{ figur_id: 'fig_3', typ: 'elternteil' }] },
    { id: 'fig_3', name: 'Adrian', typ: 'nebenfigur' },
  ], ME, {}, { reconcile: true, onMissing: 'stale' });
  const back = db.prepare(`SELECT COUNT(*) AS n FROM figure_relations r JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND ft.name = 'Adrian'`).get(TARGET).n;
  assert.equal(back, 0);
});

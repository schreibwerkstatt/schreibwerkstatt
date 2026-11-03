'use strict';
// Integration: GET /figures/:book_id/relation-check (routes/figures.js →
// finetune-export/lib/relation-check-book.js). Dieselbe Beziehungsprüfung wie
// vor dem Fine-Tuning-Export, hier als Hinweis für die Figuren-Karte: zwei
// Väter mit kopierter Beschreibung werden gemeldet, die Quellen lösen auf ihre
// Kanten auf (`edges`), und ab `editor` (Viewer sieht die Figuren-Karte nicht).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'relcheck-autor@test.dev';
const VIEWER = 'relcheck-viewer@test.dev';
const BOOK = 9511;
const NOW = '2026-01-01T00:00:00.000Z';
const VATER = 'Ein distanzierter, lesender Vater, der ihm bei der Stellensuche hilft.';

let server; let baseUrl;

async function call(path, user = ME) {
  const r = await fetch(baseUrl + path, { headers: { 'x-test-user': user } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  bootstrap();
  const { db } = require('../../db/schema');
  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, VIEWER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Buch', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, VIEWER, 'viewer', ME);

  const { saveFigurenToDb } = require('../../db/figures');
  saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Stefan', typ: 'hauptfigur', geschlecht: 'männlich',
      beziehungen: [
        { figur_id: 'fig_2', typ: 'elternteil', beschreibung: VATER },
        { figur_id: 'fig_3', typ: 'elternteil', beschreibung: VATER },
      ] },
    { id: 'fig_2', name: 'Peter', typ: 'nebenfigur', geschlecht: 'männlich' },
    { id: 'fig_3', name: 'Adrian', typ: 'nebenfigur', geschlecht: 'männlich' },
    { id: 'fig_4', name: 'Gisela', typ: 'nebenfigur', geschlecht: 'weiblich' },
  ], ME, {}, { reconcile: true, onMissing: 'stale' });

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/figures', require('../../routes/figures'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('zwei Väter mit kopierter Beschreibung: gemeldet, Quellen lösen auf ihre Kanten auf', async () => {
  const r = await call(`/figures/${BOOK}/relation-check`);
  assert.equal(r.status, 200);
  const rules = r.body.conflicts.map(c => c.rule).sort();
  assert.deepEqual(rules, ['duplicateDescription', 'maxParents']);
  assert.ok(r.body.mainCount >= 1, 'Stefan ist Hauptfigur');
  const maxParents = r.body.conflicts.find(c => c.rule === 'maxParents');
  assert.deepEqual([...maxParents.figIds].sort(), ['fig_1', 'fig_2', 'fig_3']);
  assert.equal(maxParents.pairs, undefined, 'interne Sperr-Paare bleiben serverseitig');
  const edges = r.body.edges.map(e => `${e.from}>${e.to}:${e.typ}`).sort();
  assert.deepEqual(edges, ['fig_1>fig_2:elternteil', 'fig_1>fig_3:elternteil']);
  for (const s of maxParents.sources) {
    assert.ok(r.body.edges.some(e => s === `relation:${e.id}`), `Quelle ${s} hat eine Kante`);
  }
});

test('Viewer: 403 (die Figuren-Karte ist editor+)', async () => {
  const r = await call(`/figures/${BOOK}/relation-check`, VIEWER);
  assert.equal(r.status, 403);
});

'use strict';
// Buchreihen (docs/buchreihen.md): Reihe als Verbund, «Aus Vorband übernehmen»,
// und wie die Komplettanalyse die übernommenen bzw. gepflegten Einträge respektiert.
//
// Kern der Sache:
//  - Gepflegte Welt-Fakten (manually_edited) überleben den Full-Replace; eine
//    gleichlautende Analyse-Aussage hängt nur ihre Kapitel an.
//  - Eine Figur, die die Analyse in diesem Buch nie gefunden hat (übernommen oder
//    im Katalog angelegt), wird nicht «nicht mehr im Text».
//  - Reihen-Änderungen verlangen owner auf jedem Band; übernommen wird nur aus Vorbänden.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bootstrap } = require('./_helpers/setup');

const USER = 'reihe@test.dev';
const OTHER = 'fremd@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
let ctx, db, dbSchema, server, baseUrl, seq = 0;
let currentUser = USER;

test.before(async () => {
  ctx = bootstrap();
  dbSchema = require('../../db/schema');
  db = dbSchema.db;
  for (const e of [USER, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(e, e);
  await new Promise((resolve) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: currentUser } }; next(); });
    app.use('/book-series', require('../../routes/book-series'));
    app.use('/world-facts', require('../../routes/world-facts'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { server?.close(); ctx.cleanup(); });
test.beforeEach(() => { currentUser = USER; });

function newBook(name = 'Band', owner = USER) {
  const bookId = 9700 + (++seq);
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, `${name} ${bookId}`, NOW, NOW, owner);
  grantAccess(bookId, owner, 'owner', owner);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(bookId * 10, bookId, 'Kapitel 1', NOW);
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

const facts = (bookId) => db.prepare(
  'SELECT id, subjekt, fakt, manually_edited FROM world_facts WHERE book_id = ? AND user_email = ? ORDER BY sort_order, id',
).all(bookId, USER);

const FIG_ANALYSE = { reconcile: true, onMissing: 'stale' };
const idMaps = (bookId) => ({ chNameToId: { 'Kapitel 1': bookId * 10 }, pageNameToIdByChapter: {} });

// ── Welt-Fakten: gepflegt vs. Analyse ───────────────────────────────────────

test('Full-Replace lässt gepflegte Fakten stehen und hängt gleichlautende Funde an', async () => {
  const book = newBook();
  dbSchema.saveFaktenToDb(book, [{ kapitel: 'Kapitel 1', fakten: [{ subjekt: 'Stab', fakt: 'leuchtet blau' }, { fakt: 'alt' }] }], USER);
  const r = await api('POST', `/world-facts/${book}`, { kategorie: 'objekt', subjekt: 'Ring', fakt: 'macht unsichtbar' });
  assert.equal(r.status, 200);
  // KI-Fakt bearbeiten → wird gepflegt.
  const stab = facts(book).find(f => f.subjekt === 'Stab');
  assert.equal((await api('PATCH', `/world-facts/${book}/${stab.id}`, { fakt: 'leuchtet grün' })).status, 200);

  // Neuer Analyse-Lauf: findet «Ring: macht unsichtbar» wieder, «alt» nicht mehr.
  dbSchema.saveFaktenToDb(book, [{ kapitel: 'Kapitel 1', fakten: [{ subjekt: 'Ring', fakt: 'macht unsichtbar' }, { fakt: 'neu' }] }], USER);
  const after = facts(book);
  assert.deepEqual(after.map(f => f.fakt).sort(), ['leuchtet grün', 'macht unsichtbar', 'neu']);
  const ring = after.find(f => f.subjekt === 'Ring');
  assert.equal(ring.manually_edited, 1, 'keine zweite Zeile für dieselbe Aussage');
  const bridge = db.prepare('SELECT chapter_id FROM world_fact_chapters WHERE fact_id = ?').all(ring.id);
  assert.deepEqual(bridge.map(b => b.chapter_id), [book * 10]);

  // GET liefert die Markierung, DELETE entfernt.
  const list = await api('GET', `/world-facts/${book}`);
  assert.equal(list.json.fakten.find(f => f.id === ring.id).manuell, true);
  assert.equal((await api('DELETE', `/world-facts/${book}/${ring.id}`)).status, 200);
  assert.equal(facts(book).some(f => f.id === ring.id), false);
});

test('Welt-Fakt ohne Aussage → 400 FAKT_REQUIRED', async () => {
  const book = newBook();
  const r = await api('POST', `/world-facts/${book}`, { fakt: '  ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'FAKT_REQUIRED');
});

// ── Figuren: nie gefunden ≠ nicht mehr im Text ──────────────────────────────

test('Analyse markiert eine nie gefundene Figur nicht als «nicht mehr im Text»', () => {
  const book = newBook();
  dbSchema.saveFigurenToDb(book, [{ id: 'fig_1', name: 'Anna' }, { id: 'fig_2', name: 'Bruno' }], USER, idMaps(book), FIG_ANALYSE);
  // Im Katalog angelegt: ki_name leer.
  db.prepare("INSERT INTO figures (book_id, fig_id, name, user_email, manually_edited, updated_at) VALUES (?, 'man_x', 'Clara', ?, 1, ?)")
    .run(book, USER, NOW);

  dbSchema.saveFigurenToDb(book, [{ id: 'fig_1', name: 'Anna' }], USER, idMaps(book), FIG_ANALYSE);
  const st = Object.fromEntries(db.prepare('SELECT name, stale FROM figures WHERE book_id = ?').all(book).map(r => [r.name, r.stale]));
  assert.deepEqual(st, { Anna: 0, Bruno: 1, Clara: 0 });
});

// ── Reihe ───────────────────────────────────────────────────────────────────

test('Reihe anlegen, beitreten, umordnen, verlassen; EPUB-Felder folgen', async () => {
  const b1 = newBook('Eins');
  const b2 = newBook('Zwei');
  const { seriesMetaForBook } = require('../../db/book-series');

  let r = await api('POST', `/book-series/${b1}`, { name: 'Die Saga' });
  assert.equal(r.status, 200);
  assert.equal(r.json.series.position, 1);

  r = await api('GET', `/book-series/${b2}`);
  assert.ok(r.json.joinable.some(s => s.id === r.json.joinable[0].id && s.name === 'Die Saga'));
  r = await api('POST', `/book-series/${b2}/join`, { series_id: r.json.joinable[0].id });
  assert.equal(r.status, 200);
  assert.equal(r.json.series.position, 2);
  assert.deepEqual(r.json.prequels.map(p => p.book_id), [b1]);
  assert.deepEqual(seriesMetaForBook(b2), { series: 'Die Saga', series_index: '2' });
  // Einziger Ort der Reihe: die Publikations-Metadaten (EPUB, Fassung) lesen sie dort.
  const pubMeta = require('../../db/book-publication').getMeta(b2);
  assert.equal(pubMeta.series, 'Die Saga');
  assert.equal(pubMeta.series_index, '2');

  r = await api('PUT', `/book-series/${b2}/order`, { book_ids: [b2, b1] });
  assert.equal(r.status, 200);
  assert.equal(r.json.series.position, 1);
  assert.equal((await api('PUT', `/book-series/${b2}/order`, { book_ids: [b2] })).json.error_code, 'INVALID_ORDER');

  r = await api('POST', `/book-series/${b2}/leave`);
  assert.equal(r.json.series, null);
  assert.deepEqual(seriesMetaForBook(b1), { series: 'Die Saga', series_index: '1' });
  await api('POST', `/book-series/${b1}/leave`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM book_series WHERE name = 'Die Saga'").get().n, 0, 'leere Reihe fällt weg');
});

test('Beitreten verlangt owner auf jedem Band der Reihe', async () => {
  const fremd = newBook('Fremd', OTHER);
  currentUser = OTHER;
  const r0 = await api('POST', `/book-series/${fremd}`, { name: 'Fremde Reihe' });
  currentUser = USER;
  const own = newBook('Eigen');
  const r = await api('POST', `/book-series/${own}/join`, { series_id: r0.json.series.id });
  assert.equal(r.status, 403);
});

// ── Aus Vorband übernehmen ──────────────────────────────────────────────────

test('Übernahme kopiert gepflegt, überspringt Vorhandenes, Analyse lässt die Kopien stehen', async () => {
  const b1 = newBook('Eins');
  const b2 = newBook('Zwei');
  const s = await api('POST', `/book-series/${b1}`, { name: 'Zyklus' });
  await api('POST', `/book-series/${b2}/join`, { series_id: s.json.series.id });

  dbSchema.saveFigurenToDb(b1, [
    { id: 'fig_1', name: 'Anna', beziehungen: [{ figur_id: 'fig_2', typ: 'freund' }] },
    { id: 'fig_2', name: 'Bruno' },
  ], USER, idMaps(b1), FIG_ANALYSE);
  const anna1 = db.prepare("SELECT id FROM figures WHERE book_id = ? AND name = 'Anna'").get(b1).id;
  db.prepare('INSERT INTO figure_aliases (figure_id, book_id, alias) VALUES (?, ?, ?)').run(anna1, b1, 'Anni');
  dbSchema.saveOrteToDb(b1, [{ id: 'ort_1', name: 'Burg' }], USER, {}, {}, { matchBy: 'name', onMissing: 'stale' });
  dbSchema.saveFaktenToDb(b1, [{ kapitel: 'Kapitel 1', fakten: [{ subjekt: 'Burg', fakt: 'hat drei Türme' }] }], USER);
  // Im Zielband gibt es Bruno schon.
  dbSchema.saveFigurenToDb(b2, [{ id: 'fig_1', name: 'Bruno' }], USER, idMaps(b2), FIG_ANALYSE);

  const cand = await api('GET', `/book-series/${b2}/carryover/${b1}`);
  assert.equal(cand.status, 200);
  assert.equal(cand.json.figuren.find(f => f.name === 'Bruno').vorhanden, true);

  const sel = {
    source_book_id: b1,
    figuren: cand.json.figuren.map(f => f.id),
    orte: cand.json.orte.map(o => o.id),
    fakten: cand.json.fakten.map(f => f.id),
  };
  const r = await api('POST', `/book-series/${b2}/carryover`, sel);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.figuren, r.json.orte, r.json.fakten], [1, 1, 1]);

  const anna2 = db.prepare("SELECT * FROM figures WHERE book_id = ? AND name = 'Anna'").get(b2);
  assert.equal(anna2.origin_figure_id, anna1);
  assert.equal(anna2.manually_edited, 1);
  assert.equal(anna2.ki_name, null);
  assert.deepEqual(db.prepare('SELECT alias FROM figure_aliases WHERE figure_id = ?').all(anna2.id).map(a => a.alias), ['Anni']);
  const burg = db.prepare("SELECT manually_created, origin_location_id FROM locations WHERE book_id = ? AND name = 'Burg'").get(b2);
  assert.equal(burg.manually_created, 1);
  assert.ok(burg.origin_location_id);

  // Zweite Übernahme: nichts doppelt.
  const again = await api('POST', `/book-series/${b2}/carryover`, sel);
  assert.deepEqual([again.json.figuren, again.json.orte, again.json.fakten], [0, 0, 0]);

  // Analyse des Bandes 2 findet nur Bruno: Anna bleibt aktiv, der Fakt bleibt.
  dbSchema.saveFigurenToDb(b2, [{ id: 'fig_1', name: 'Bruno' }], USER, idMaps(b2), FIG_ANALYSE);
  dbSchema.saveFaktenToDb(b2, [{ kapitel: 'Kapitel 1', fakten: [{ fakt: 'Bruno ist müde' }] }], USER);
  assert.equal(db.prepare('SELECT stale FROM figures WHERE id = ?').get(anna2.id).stale, 0);
  assert.ok(facts(b2).some(f => f.fakt === 'hat drei Türme'));

  // Band 2 ist kein Vorband von Band 1.
  assert.equal((await api('GET', `/book-series/${b1}/carryover/${b2}`)).json.error_code, 'NOT_A_PREQUEL');
});

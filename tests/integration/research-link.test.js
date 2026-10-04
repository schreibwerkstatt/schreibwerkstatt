'use strict';
// Integration test: Recherche-Verknüpfungs-Job (routes/jobs/research-link.js).
// Deckt die Laufzeit-Filterung von runResearchLinkJob ab — die fehleranfälligste
// Stelle: KI-Halluzinations-Schutz (nur existierende Kandidaten-ids dürfen
// durch), art→kind-Mapping, Dedup gegen Mehrfach-Vorschläge UND gegen bereits
// bestehende Verknüpfungen, grund-Truncation, Leer-Kandidaten-Short-Circuit.
// Persistiert NICHTS — der Job liefert nur Vorschläge.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let db;
let researchLink;

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  researchLink = require('../../routes/jobs/research-link');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  // Recherche-Tabellen + Welt-Entitäten zwischen Tests leeren (book CASCADE
  // räumt items/links/urls; Entitäten/acts/threads explizit).
  for (const t of ['research_item_links', 'research_item_urls', 'research_items',
    'plot_beats', 'plot_acts', 'plot_threads', 'figure_scenes', 'locations', 'figures', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

const USER = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

// Buch + ein Recherche-Item + die fünf Kandidaten-Typen. Gibt die ids zurück.
function seedWorld(bookId, { withBeat = true } = {}) {
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)")
    .run(bookId, NOW, NOW);
  const itemId = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, body, source, created_at, updated_at)
     VALUES (?, ?, 'note', 'Bronzezeit', 'Notiz über Grabungen', 'Wikipedia', ?, ?)`
  ).run(bookId, USER, NOW, NOW).lastInsertRowid;

  const figureId = db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, 'f1', 'Anna', 0, ?)`
  ).run(bookId, USER, NOW).lastInsertRowid;
  const locationId = db.prepare(
    `INSERT INTO locations (book_id, user_email, loc_id, name, sort_order, updated_at) VALUES (?, ?, 'l1', 'Olten', 0, ?)`
  ).run(bookId, USER, NOW).lastInsertRowid;
  const sceneId = db.prepare(
    `INSERT INTO figure_scenes (book_id, user_email, titel, sort_order, updated_at) VALUES (?, ?, 'Marktplatz', 0, ?)`
  ).run(bookId, USER, NOW).lastInsertRowid;
  const threadId = db.prepare(
    `INSERT INTO plot_threads (book_id, user_email, name, position) VALUES (?, ?, 'Hauptstrang', 0)`
  ).run(bookId, USER).lastInsertRowid;

  let beatId = null;
  if (withBeat) {
    const actId = db.prepare(
      `INSERT INTO plot_acts (book_id, user_email, name, position) VALUES (?, ?, 'Akt 1', 0)`
    ).run(bookId, USER).lastInsertRowid;
    beatId = db.prepare(
      `INSERT INTO plot_beats (book_id, user_email, act_id, titel, sort_order) VALUES (?, ?, ?, 'Wendepunkt', 0)`
    ).run(bookId, USER, actId).lastInsertRowid;
  }
  return { itemId, figureId, locationId, sceneId, threadId, beatId };
}

function runJob(bookId, itemId) {
  const jobId = ctx.shared.createJob('research-link', bookId, USER, 'job.label.researchLink');
  ctx.shared.enqueueJob(jobId, () => researchLink.runResearchLinkJob(jobId, itemId, bookId, USER));
  return waitForJob(ctx.shared, jobId);
}

// Mock-AI: jeder Link-Call (schemaKeys enthält 'links') liefert dieses links-Array.
function aiReturnsLinks(links) {
  ctx.mockAi.on((e) => e.schemaKeys.includes('links'), { links });
}

test('gültige Kandidaten → Vorschläge mit korrektem kind/id/label/grund', async () => {
  const BOOK_ID = 7201;
  const ids = seedWorld(BOOK_ID);
  aiReturnsLinks([
    { art: 'figur', id: ids.figureId, grund: 'Anna kommt in der Notiz vor' },
    { art: 'ort',   id: ids.locationId, grund: 'Olten ist der Fundort' },
    { art: 'strang', id: ids.threadId, grund: 'gehört zum Hauptstrang' },
    { art: 'beat',  id: ids.beatId, grund: 'liefert den Wendepunkt' },
  ]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.status, 'done', job.error || '');
  const s = job.result.suggestions;
  assert.equal(s.length, 4);

  const byKind = Object.fromEntries(s.map(x => [x.target_kind, x]));
  assert.deepEqual(byKind.figure, { target_kind: 'figure', target_id: ids.figureId, label: 'Anna', grund: 'Anna kommt in der Notiz vor' });
  assert.equal(byKind.location.target_id, ids.locationId);
  assert.equal(byKind.location.label, 'Olten');
  assert.equal(byKind.thread.target_id, ids.threadId);   // strang → thread
  assert.equal(byKind.beat.target_id, ids.beatId);
  // Nichts wurde persistiert.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_links').get().n, 0);
});

test('halluzinierte id (nicht unter den Kandidaten) wird verworfen', async () => {
  const BOOK_ID = 7202;
  const ids = seedWorld(BOOK_ID);
  aiReturnsLinks([
    { art: 'figur', id: 999999, grund: 'erfunden' },
    { art: 'figur', id: ids.figureId, grund: 'echt' },
  ]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.suggestions.length, 1);
  assert.equal(job.result.suggestions[0].target_id, ids.figureId);
});

test('falsche art zu einer existierenden id wird verworfen', async () => {
  const BOOK_ID = 7203;
  const ids = seedWorld(BOOK_ID);
  // Zweite Figur → id, zu der es garantiert KEINE Location gibt (IDs starten je
  // Tabelle bei 1, kollidieren also sonst). Diese Figur-id als 'ort' adressiert →
  // byArtId-Key 'ort:<id>' fehlt → Vorschlag fällt raus.
  const lonelyFigureId = db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, 'f2', 'Ben', 1, ?)`
  ).run(BOOK_ID, USER, NOW).lastInsertRowid;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM locations WHERE id = ?').get(lonelyFigureId).n, 0);
  aiReturnsLinks([{ art: 'ort', id: lonelyFigureId, grund: 'verwechselt' }]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.suggestions.length, 0);
});

test('Mehrfach-Vorschlag desselben Ziels wird dedupliziert', async () => {
  const BOOK_ID = 7204;
  const ids = seedWorld(BOOK_ID);
  aiReturnsLinks([
    { art: 'figur', id: ids.figureId, grund: 'erst' },
    { art: 'figur', id: ids.figureId, grund: 'nochmal' },
  ]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.result.suggestions.length, 1);
  assert.equal(job.result.suggestions[0].grund, 'erst');   // erster gewinnt
});

test('bereits bestehende Verknüpfung wird nicht erneut vorgeschlagen', async () => {
  const BOOK_ID = 7205;
  const ids = seedWorld(BOOK_ID);
  db.prepare(
    `INSERT INTO research_item_links (item_id, target_kind, figure_id, created_at) VALUES (?, 'figure', ?, ?)`
  ).run(ids.itemId, ids.figureId, NOW);

  aiReturnsLinks([
    { art: 'figur', id: ids.figureId, grund: 'schon verknüpft' },
    { art: 'ort',   id: ids.locationId, grund: 'neu' },
  ]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.result.suggestions.length, 1);
  assert.equal(job.result.suggestions[0].target_kind, 'location');
});

test('grund wird auf 200 Zeichen gekürzt', async () => {
  const BOOK_ID = 7206;
  const ids = seedWorld(BOOK_ID);
  aiReturnsLinks([{ art: 'figur', id: ids.figureId, grund: 'x'.repeat(500) }]);

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.result.suggestions[0].grund.length, 200);
});

test('keine Kandidaten → empty:true, kein KI-Call', async () => {
  const BOOK_ID = 7207;
  // Buch + Item, aber KEINE Welt-Entitäten.
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Leer', ?, ?)").run(BOOK_ID, NOW, NOW);
  const itemId = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, created_at, updated_at) VALUES (?, ?, 'note', 'T', ?, ?)`
  ).run(BOOK_ID, USER, NOW, NOW).lastInsertRowid;
  aiReturnsLinks([{ art: 'figur', id: 1, grund: 'sollte nie laufen' }]);

  const job = await runJob(BOOK_ID, itemId);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.empty, true);
  assert.deepEqual(job.result.suggestions, []);
  assert.equal(ctx.mockAi.log.length, 0, 'KI darf ohne Kandidaten nicht angefragt werden');
});

test('KI ohne links-Array → failJob (researchLinksMissing)', async () => {
  const BOOK_ID = 7208;
  const ids = seedWorld(BOOK_ID, { withBeat: false });
  ctx.mockAi.on((e) => e.schemaKeys.includes('links'), { irgendwas: true });

  const job = await runJob(BOOK_ID, ids.itemId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.researchLinksMissing');
});

test('unbekanntes Item → failJob (researchItemMissing), kein KI-Call', async () => {
  const BOOK_ID = 7209;
  seedWorld(BOOK_ID, { withBeat: false });
  aiReturnsLinks([]);

  const job = await runJob(BOOK_ID, 888888);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.researchItemMissing');
  assert.equal(ctx.mockAi.log.length, 0);
});

test('Seiten-Vorschläge aus den Embeddings: eigene Seiten mit Auszug, fremde und schon verknüpfte fallen weg', async () => {
  const BOOK_ID = 7210;
  const ids = seedWorld(BOOK_ID);
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (7211, 'Fremd', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (721001, ?, 'Grabung', 1, ?)").run(BOOK_ID, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (721002, ?, 'Schon da', 2, ?)").run(BOOK_ID, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (721101, 7211, 'Fremdseite', 1, ?)").run(NOW);
  db.prepare("INSERT INTO research_item_links (item_id, target_kind, page_id) VALUES (?, 'page', 721002)").run(ids.itemId);
  aiReturnsLinks([]);

  const embed = require('../../lib/embed');
  const sr = require('../../lib/semantic-retrieval');
  const orig = { isEnabled: embed.isEnabled, similarToEntity: sr.similarToEntity };
  embed.isEnabled = () => true;
  sr.similarToEntity = async (bookId, kind, id) => {
    assert.equal(kind, 'research');
    assert.equal(id, ids.itemId);
    return { notIndexed: false, hits: [
      { kind: 'page', entity_id: 721101, text: 'fremd', score: 0.9 },
      { kind: 'page', entity_id: 721001, text: 'Sie gruben   in Olten.', score: 0.8 },
      { kind: 'page', entity_id: 721002, text: 'schon verknüpft', score: 0.7 },
    ] };
  };
  try {
    const job = await runJob(BOOK_ID, ids.itemId);
    assert.equal(job.status, 'done', job.error || '');
    assert.deepEqual(job.result.suggestions, [
      { target_kind: 'page', target_id: 721001, label: 'Grabung', grund: '„Sie gruben in Olten."', source: 'semantic' },
    ]);
  } finally {
    embed.isEnabled = orig.isEnabled;
    sr.similarToEntity = orig.similarToEntity;
  }
});

test('Seiten-Vorschläge: nicht indexiertes Fundstück → Freitext-Anfrage (Array-Rückgabe)', async () => {
  const BOOK_ID = 7212;
  const ids = seedWorld(BOOK_ID);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (721201, ?, 'Grabung', 1, ?)").run(BOOK_ID, NOW);
  aiReturnsLinks([]);
  const embed = require('../../lib/embed');
  const sr = require('../../lib/semantic-retrieval');
  const orig = { isEnabled: embed.isEnabled, similarToEntity: sr.similarToEntity, semanticQuery: sr.semanticQuery };
  embed.isEnabled = () => true;
  sr.similarToEntity = async () => ({ notIndexed: true, hits: [] });
  let q = null;
  sr.semanticQuery = async (bookId, query) => { q = query; return [{ kind: 'page', entity_id: 721201, text: 'Grabung', score: 0.5 }]; };
  try {
    const job = await runJob(BOOK_ID, ids.itemId);
    assert.equal(job.status, 'done', job.error || '');
    assert.match(q, /Bronzezeit/);
    assert.deepEqual(job.result.suggestions.map(s => s.target_id), [721201]);
  } finally {
    Object.assign(embed, { isEnabled: orig.isEnabled });
    Object.assign(sr, { similarToEntity: orig.similarToEntity, semanticQuery: orig.semanticQuery });
  }
});

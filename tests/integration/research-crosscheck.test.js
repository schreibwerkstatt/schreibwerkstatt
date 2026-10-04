'use strict';
// Integration: Recherche-Abgleich (routes/jobs/research-crosscheck.js).
// Geprueft wird die Laufzeit-Filterung — der eigentliche Schutz gegen ein
// halluzinierendes Modell: nur Befunde zu Fundstuecken und Seiten des Buendels,
// `stelle` woertlich im gelieferten Seitentext, `zitat` nur bei Zitat-Fundstuecken.
// Dazu Kandidatenwahl (fact/quote, nicht verworfen), Ersetzen je Lauf und die
// Ausgabe der Befunde am Fundstueck.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let db;
let job;

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  job = require('../../routes/jobs/research-crosscheck');
});
test.after(() => { ctx.cleanup(); });

const USER = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
const BOOK = 7301;

function seed() {
  for (const t of ['research_item_findings', 'research_item_links', 'research_items', 'pages', 'books']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Abgleich', ?, ?)").run(BOOK, NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (730101, ?, 'Landung', 1, ?, '<p>Am 21. Juli 1968 betrat Armstrong den Mond. „Ein kleiner Schritt für einen Menschen", sagte er.</p>')`).run(BOOK, NOW);
  const ins = db.prepare("INSERT INTO research_items (book_id, user_email, kind, title, body, status) VALUES (?, ?, ?, ?, ?, ?)");
  const fact = ins.run(BOOK, USER, 'fact', 'Mondlandung', 'Armstrong betrat den Mond am 21. Juli 1969.', 'offen').lastInsertRowid;
  const quote = ins.run(BOOK, USER, 'quote', 'Armstrong', 'Das ist ein kleiner Schritt für einen Menschen, ein riesiger Sprung für die Menschheit.', 'offen').lastInsertRowid;
  const dropped = ins.run(BOOK, USER, 'fact', 'Verworfen', 'egal', 'verworfen').lastInsertRowid;
  const note = ins.run(BOOK, USER, 'note', 'Notiz', 'keine Prüfung', 'offen').lastInsertRowid;
  for (const id of [fact, quote, dropped, note]) {
    db.prepare("INSERT INTO research_item_links (item_id, target_kind, page_id) VALUES (?, 'page', 730101)").run(id);
  }
  return { fact, quote, dropped, note };
}

function run(itemId = null) {
  const id = ctx.shared.createJob('research-crosscheck', BOOK, USER, 'job.label.researchCrosscheck');
  ctx.shared.enqueueJob(id, () => job.runResearchCrosscheckJob(id, BOOK, itemId, USER));
  return waitForJob(ctx.shared, id);
}

test('nur belegte Befunde werden gespeichert; Kandidaten = fact/quote ohne verworfen', async () => {
  const ids = seed();
  ctx.mockAi.reset();
  let prompt = '';
  ctx.mockAi.on((e) => { prompt = e.prompt || prompt; return e.schemaKeys.includes('befunde'); }, { befunde: [
    { item_id: ids.fact, page_id: 730101, typ: 'widerspruch', stelle: 'Am 21. Juli 1968 betrat Armstrong den Mond.', erklaerung: 'Jahr 1968 statt 1969' },
    { item_id: ids.quote, page_id: 730101, typ: 'zitat', stelle: '„Ein kleiner Schritt für einen Menschen"', erklaerung: 'zweite Hälfte fehlt' },
    { item_id: ids.fact, page_id: 730101, typ: 'widerspruch', stelle: 'Diese Stelle steht nirgends im Text.', erklaerung: 'erfunden' },
    { item_id: ids.fact, page_id: 999999, typ: 'widerspruch', stelle: 'Am 21. Juli 1968', erklaerung: 'fremde Seite' },
    { item_id: ids.fact, page_id: 730101, typ: 'zitat', stelle: 'Am 21. Juli 1968', erklaerung: 'zitat an einem Fakt' },
    { item_id: ids.note, page_id: 730101, typ: 'widerspruch', stelle: 'Am 21. Juli 1968', erklaerung: 'kein Kandidat' },
  ] });

  const r = await run();
  assert.equal(r.status, 'done', r.error || '');
  assert.equal(r.result.checked, 2);
  assert.equal(r.result.findings, 2);
  const rows = db.prepare('SELECT item_id, typ FROM research_item_findings ORDER BY item_id').all();
  assert.deepEqual(rows, [{ item_id: ids.fact, typ: 'widerspruch' }, { item_id: ids.quote, typ: 'zitat' }]);

  // Ausgabe am Fundstueck: mit Seitennamen.
  const { emitItem } = require('../../db/research-items');
  const it = emitItem(ids.fact);
  assert.equal(it.findings.length, 1);
  assert.equal(it.findings[0].page_name, 'Landung');

  // Zweiter Lauf ohne Befunde ersetzt die alten.
  ctx.mockAi.reset();
  ctx.mockAi.on((e) => e.schemaKeys.includes('befunde'), { befunde: [] });
  const r2 = await run();
  assert.equal(r2.status, 'done', r2.error || '');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_findings').get().n, 0);
});

test('KI ohne befunde-Array → Fehler, nichts geschrieben', async () => {
  seed();
  ctx.mockAi.reset();
  ctx.mockAi.on((e) => e.schemaKeys.includes('befunde'), { foo: 1 });
  const r = await run();
  assert.equal(r.status, 'error');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_item_findings').get().n, 0);
});

test('Fundstück ohne Manuskriptstelle (keine Verknüpfung, keine Embeddings) → unchecked, kein KI-Call', async () => {
  seed();
  db.prepare('DELETE FROM research_item_links').run();
  ctx.mockAi.reset();
  const r = await run();
  assert.equal(r.status, 'done', r.error || '');
  assert.equal(r.result.checked, 0);
  assert.equal(r.result.unchecked, 2);
  assert.equal(ctx.mockAi.log.length, 0);
});

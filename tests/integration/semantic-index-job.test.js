'use strict';
// Integration test: der Embedding-Index-Job (routes/jobs/embed-index.js) gegen
// eine echte DB, mit gestubbtem Embedding-Endpunkt. Prüft, was nur im
// Zusammenspiel aus Job, semantic_chunks und semantic_index_state sichtbar wird:
//   - Schauplätze und Weltfakten landen im Index, stale-Figuren nicht
//   - ein vollständiger Lauf stempelt semantic_index_state (isIndexed)
//   - ein zweiter Lauf ohne Änderung embeddet nichts und schreibt nichts
//   - eine während des Laufs gelöschte Entität reisst den Lauf nicht mit
//   - eine falsch eingestellte Dimension bricht mit eigenem Fehler ab
//   - Chunks eines früheren Modells räumt der vollständige Lauf weg

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');
const seed = require('./_helpers/db-seed');

const NOW = '2026-01-01T00:00:00.000Z';
const MODEL = 'test-embed';

let ctx, db, embed, semanticChunks, embedIndex, shared;
let embedCalls = 0;
let dim = 3;
let onEmbed = null;

// Deterministischer Pseudo-Vektor aus dem Text (Länge = aktuelle dim).
function fakeVec(text, n) {
  const v = new Float32Array(n);
  for (let i = 0; i < text.length; i++) v[i % n] += text.charCodeAt(i) % 7;
  v[0] += 1;
  return v;
}

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  embed = require('../../lib/embed');
  embed.isEnabled = () => true;
  embed.getConfig = () => ({ model: MODEL, dim: 3, passagePrefix: '' });
  embed.embedBatch = async (texts) => {
    embedCalls++;
    if (onEmbed) { const f = onEmbed; onEmbed = null; f(); }
    return texts.map(t => fakeVec(t, dim));
  };
  semanticChunks = require('../../db/semantic-chunks');
  embedIndex = require('../../routes/jobs/embed-index');
  shared = require('../../routes/jobs/shared');
});
test.after(() => ctx.cleanup());

test.beforeEach(() => {
  for (const t of ['semantic_chunks', 'semantic_index_state', 'world_facts', 'locations', 'figures']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  seed.reset();
  embedCalls = 0;
  dim = 3;
  onEmbed = null;
  seed.setBook({
    chapters: [{ id: 10, book_id: 1, name: 'Eins' }],
    pages: [
      { id: 101, book_id: 1, chapter_id: 10, name: 'Anfang', position: 1 },
      { id: 102, book_id: 1, chapter_id: 10, name: 'Mitte', position: 2 },
    ],
    pageBodies: {
      101: '<p>Am Leuchtturm wartet Anna auf das Schiff.</p>',
      102: '<p>Der Sturm zieht über die Bucht.</p>',
    },
  });
  db.prepare(`INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, updated_at)
              VALUES (1, 'loc_1', 'Leuchtturm', 'Gebäude', 'Weiss, am Kap', ?)`).run(NOW);
  db.prepare(`INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, updated_at)
              VALUES (1, 'Geografie', 'Kap', 'Das Kap liegt im Norden.', ?)`).run(NOW);
  db.prepare(`INSERT INTO figures (book_id, fig_id, name, beschreibung, stale, updated_at)
              VALUES (1, 'fig_1', 'Anna', 'Wärterin', 0, ?)`).run(NOW);
  db.prepare(`INSERT INTO figures (book_id, fig_id, name, beschreibung, stale, updated_at)
              VALUES (1, 'fig_2', 'Geist', 'nicht mehr im Text', 1, ?)`).run(NOW);
});

async function runIndex() {
  const jobId = embedIndex.enqueueEmbedIndexJob(1);
  assert.ok(jobId);
  return waitForJob(shared, jobId, { timeoutMs: 10000 });
}

const kinds = () => db.prepare('SELECT DISTINCT kind FROM semantic_chunks ORDER BY kind').all().map(r => r.kind);

test('Schauplätze + Weltfakten indiziert, stale-Figur nicht, Index-Stand gesetzt', async () => {
  assert.equal(semanticChunks.isIndexed(1, MODEL), false);
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(kinds(), ['fact', 'figure', 'location', 'page']);
  const figs = db.prepare("SELECT f.fig_id FROM semantic_chunks sc JOIN figures f ON f.id = sc.entity_id WHERE sc.kind = 'figure'").all();
  assert.deepEqual(figs.map(r => r.fig_id), ['fig_1']);
  assert.equal(semanticChunks.isIndexed(1, MODEL), true);
});

test('zweiter Lauf ohne Änderung: kein Embedding, kein Schreiben', async () => {
  await runIndex();
  const before = db.prepare('SELECT id, created_at FROM semantic_chunks ORDER BY id').all();
  embedCalls = 0;
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  assert.equal(embedCalls, 0);
  assert.deepEqual(db.prepare('SELECT id, created_at FROM semantic_chunks ORDER BY id').all(), before);
});

test('während des Laufs gelöschte Seite reisst den Lauf nicht mit', async () => {
  onEmbed = () => db.prepare('DELETE FROM pages WHERE page_id = 102').run();
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  const pages = db.prepare("SELECT DISTINCT entity_id FROM semantic_chunks WHERE kind = 'page'").all().map(r => r.entity_id);
  assert.deepEqual(pages, [101]);
  assert.equal(semanticChunks.isIndexed(1, MODEL), true);
});

test('falsche Dimension: Abbruch mit eigenem Fehler, kein Index-Stand', async () => {
  dim = 4;
  const job = await runIndex();
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /embedDimMismatch/);
  assert.equal(semanticChunks.isIndexed(1, MODEL), false);
});

test('vollständiger Lauf räumt Chunks eines früheren Modells', async () => {
  semanticChunks.replaceEntity('page', 101, 1, 'old-model', 3, [
    { chunk_ix: 0, content_hash: 'x', vector: Float32Array.from([1, 0, 0]), text: 'alt' },
  ]);
  semanticChunks.markIndexed(1, 'old-model');
  await runIndex();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks WHERE model = 'old-model'").get().n, 0);
  assert.equal(semanticChunks.isIndexed(1, 'old-model'), false);
});

test('neighborText verschmilzt Nachbar-Chunks ohne doppelte Naht', () => {
  seed.setBook({ pages: [{ id: 103, book_id: 1, name: 'Lang' }] });
  const v = Float32Array.from([1, 0, 0]);
  semanticChunks.replaceEntity('page', 103, 1, MODEL, 3, [
    { chunk_ix: 0, content_hash: 'a', vector: v, text: 'Erster Satz hier. Zweiter Satz mit Überlappung' },
    { chunk_ix: 1, content_hash: 'b', vector: v, text: 'Zweiter Satz mit Überlappung und Fortsetzung.' },
    { chunk_ix: 2, content_hash: 'c', vector: v, text: 'Ganz anderer Schluss.' },
  ]);
  assert.equal(
    semanticChunks.neighborText('page', 103, MODEL, 0, 1),
    'Erster Satz hier. Zweiter Satz mit Überlappung und Fortsetzung.',
  );
  assert.equal(
    semanticChunks.neighborText('page', 103, MODEL, 2, 1),
    'Zweiter Satz mit Überlappung und Fortsetzung. Ganz anderer Schluss.',
  );
});

test('semanticQuery: Nur-Volltext-Treffer bekommt seinen besten Chunk statt Snippet', async () => {
  const appSettings = require('../../lib/app-settings');
  const searchIndex = require('../../lib/search');
  const { semanticQuery } = require('../../lib/semantic-retrieval');
  await runIndex();
  searchIndex.upsertPage(101);
  searchIndex.upsertPage(102);
  // Score-Floor so hoch, dass die Cosinus-Stufe nichts liefert — der Treffer
  // kann nur aus der FTS-Seite der Hybrid-Fusion kommen.
  appSettings.set('embed.min_score', 0.999, { updatedBy: 'test' });
  appSettings.set('embed.hybrid', true, { updatedBy: 'test' });
  embed.embedQuery = async () => Float32Array.from([0, 0, 1]);
  try {
    const hits = await semanticQuery(1, 'Leuchtturm', { kinds: ['page'], topK: 5 });
    const h = hits.find(x => x.entity_id === 101);
    assert.ok(h, JSON.stringify(hits));
    assert.equal(h.chunk_ix, 0);
    assert.equal(h.text, 'Am Leuchtturm wartet Anna auf das Schiff.');
    assert.equal(typeof h.semScore, 'number');
  } finally {
    appSettings.set('embed.min_score', 0.25, { updatedBy: 'test' });
  }
});

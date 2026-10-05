'use strict';
// Unit (Temp-DB): semantische Suche — Vektor-Wiederverwendung über Entitäts-
// Grenzen und User-Scope.
//  - Welt-Fakten bekommen bei jeder Komplettanalyse neue IDs (Full-Replace, die
//    CASCADE löscht die alten Chunks). Der Recycling-Puffer fängt die kaskadierten
//    Löschungen ab; der Index-Lauf danach embeddet unveränderte Fakten NICHT neu.
//  - searchSimilar mit `user` filtert fremde Analyse-Entitäten VOR dem topK-Schnitt.
//  - indexStatus zählt mit userEmail nur eigene Analyse-Änderungen als stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('semantic-fact-reuse');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const semanticChunks = require('../../db/semantic-chunks');
const { saveFaktenToDb } = require('../../db/world-facts');
const embed = require('../../lib/embed');

const MODEL = 'test-embed';
const DIM = 3;
const A = 'a@example.com';
const B = 'b@example.com';
const NOW = '2026-01-01T00:00:00.000Z';
let seq = 0;

function newBook() {
  const bookId = 7000 + (++seq);
  for (const u of [A, B]) db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(u, u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, A);
  return bookId;
}
function factIds(bookId, user) {
  return db.prepare('SELECT id FROM world_facts WHERE book_id = ? AND user_email IS ? ORDER BY sort_order').all(bookId, user).map(r => r.id);
}
function putChunk(kind, id, bookId, hash, vec) {
  semanticChunks.replaceEntity(kind, id, bookId, MODEL, DIM, [
    { chunk_ix: 0, content_hash: hash, vector: Float32Array.from(vec), text: hash },
  ]);
}

test('kaskadierte Fakt-Löschung landet im Recycling-Puffer, dropRecycled räumt', () => {
  const bookId = newBook();
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ kategorie: 'ort', subjekt: 'Kap', fakt: 'Liegt im Norden.' }] }], A);
  const [oldId] = factIds(bookId, A);
  putChunk('fact', oldId, bookId, 'h-kap', [1, 2, 3]);

  // Full-Replace mit demselben Inhalt → neue ID, alte Chunks per CASCADE weg.
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ kategorie: 'ort', subjekt: 'Kap', fakt: 'Liegt im Norden.' }] }], A);
  const [newId] = factIds(bookId, A);
  assert.notEqual(newId, oldId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks WHERE book_id = ?').get(bookId).n, 0);

  const cache = semanticChunks.reusableVectors(bookId, 'fact', MODEL, DIM);
  assert.deepEqual(Array.from(cache.get('h-kap')), [1, 2, 3]);
  assert.equal(cache.get('h-unbekannt'), null);
  // Falsche Dimension → kein Treffer.
  assert.equal(semanticChunks.reusableVectors(bookId, 'fact', MODEL, 4).get('h-kap'), null);

  // Was nach `before` gelöscht wurde, bleibt; was davor, fällt.
  semanticChunks.dropRecycled(bookId, '2000-01-01T00:00:00.000Z');
  assert.ok(semanticChunks.reusableVectors(bookId, 'fact', MODEL, DIM).get('h-kap'));
  semanticChunks.dropRecycled(bookId, '2999-01-01T00:00:00.000Z');
  assert.equal(semanticChunks.reusableVectors(bookId, 'fact', MODEL, DIM).get('h-kap'), null);
});

test('reusableVectors findet den Hash auch bei einer anderen lebenden Entität', () => {
  const bookId = newBook();
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ fakt: 'Eins.' }, { fakt: 'Zwei.' }] }], A);
  const [f1] = factIds(bookId, A);
  putChunk('fact', f1, bookId, 'h-eins', [0, 1, 0]);
  assert.deepEqual(Array.from(semanticChunks.reusableVectors(bookId, 'fact', MODEL, DIM).get('h-eins')), [0, 1, 0]);
  // Anderes kind → nicht geteilt.
  assert.equal(semanticChunks.reusableVectors(bookId, 'scene', MODEL, DIM).get('h-eins'), null);
});

test('Index-Lauf nach Fakt-Full-Replace embeddet unveränderte Fakten nicht neu', async () => {
  const bookId = newBook();
  const shared = require('../../routes/jobs/shared');
  const { runEmbedIndexJob } = require('../../routes/jobs/embed-index');
  const orig = { isEnabled: embed.isEnabled, getConfig: embed.getConfig, embedBatch: embed.embedBatch };
  let embedded = 0;
  embed.isEnabled = () => true;
  embed.getConfig = () => ({ model: MODEL, dim: DIM, passagePrefix: '' });
  embed.embedBatch = async (texts) => { embedded += texts.length; return texts.map((t) => Float32Array.from([t.length, 1, 2])); };
  try {
    const fakten = [{ kapitel: null, fakten: [{ subjekt: 'Kap', fakt: 'Liegt im Norden.' }, { subjekt: 'See', fakt: 'Ist kalt.' }] }];
    saveFaktenToDb(bookId, fakten, A);
    const run = async () => {
      const jobId = shared.createJob('embed-index', bookId, null, 'job.label.embedIndex', null, bookId);
      await runEmbedIndexJob(jobId, bookId, null);
      const job = shared.jobs.get(jobId);
      assert.equal(job.status, 'done', job.error);
      return job.result;
    };
    await run();
    assert.equal(embedded, 2);

    // Komplettanalyse ersetzt die Fakten: einer gleich, einer neu.
    saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ subjekt: 'Kap', fakt: 'Liegt im Norden.' }, { subjekt: 'Berg', fakt: 'Ist hoch.' }] }], A);
    embedded = 0;
    const res = await run();
    assert.equal(embedded, 1, 'nur der geänderte Fakt wird neu embeddet');
    assert.equal(res.rehomed, 1);
    const ids = factIds(bookId, A);
    const indexed = db.prepare("SELECT entity_id FROM semantic_chunks WHERE book_id = ? AND kind = 'fact' ORDER BY entity_id").all(bookId).map(r => r.entity_id);
    assert.deepEqual(indexed, ids.slice().sort((x, y) => x - y));
  } finally {
    Object.assign(embed, orig);
  }
});

test('searchSimilar mit user: fremde Analyse-Treffer fallen vor dem topK-Schnitt', () => {
  const bookId = newBook();
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ fakt: 'A-Fakt.' }] }], A);
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ fakt: 'B-Fakt eins.' }, { fakt: 'B-Fakt zwei.' }] }], B);
  const [a1] = factIds(bookId, A);
  const [b1, b2] = factIds(bookId, B);
  // B-Fakten liegen näher an der Anfrage als der A-Fakt.
  putChunk('fact', b1, bookId, 'hb1', [1, 0, 0]);
  putChunk('fact', b2, bookId, 'hb2', [0.9, 0.1, 0]);
  putChunk('fact', a1, bookId, 'ha1', [0.5, 0.5, 0]);
  const q = Float32Array.from([1, 0, 0]);

  const unscoped = semanticChunks.searchSimilar(bookId, MODEL, q, { topK: 1 });
  assert.equal(unscoped[0].entity_id, b1);
  const scoped = semanticChunks.searchSimilar(bookId, MODEL, q, { topK: 1, user: A });
  assert.deepEqual(scoped.map(h => h.entity_id), [a1]);
  const scopedB = semanticChunks.searchSimilar(bookId, MODEL, q, { topK: 5, user: B });
  assert.deepEqual(scopedB.map(h => h.entity_id), [b1, b2]);
});

test('indexStatus: staleCount mit userEmail zählt nur eigene Analyse-Änderungen', () => {
  const bookId = newBook();
  semanticChunks.markIndexed(bookId, MODEL);
  db.prepare("UPDATE semantic_index_state SET indexed_at = '2020-01-01T00:00:00.000Z' WHERE book_id = ?").run(bookId);
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ fakt: 'B eins.' }, { fakt: 'B zwei.' }] }], B);
  saveFaktenToDb(bookId, [{ kapitel: null, fakten: [{ fakt: 'A eins.' }] }], A);
  assert.equal(semanticChunks.indexStatus(bookId, MODEL).staleCount, 3);
  assert.equal(semanticChunks.indexStatus(bookId, MODEL, A).staleCount, 1);
  assert.equal(semanticChunks.indexStatus(bookId, MODEL, B).staleCount, 2);
});

'use strict';
// Integration test: der Quellen-Embedding-Index-Job (routes/jobs/source-embed-index.js)
// gegen eine echte DB, mit gestubbtem Embedding-Endpunkt. Prüft:
//   - Erstlauf indiziert und stempelt doc_indexed_at
//   - zweiter Lauf ohne Änderung embeddet nichts und schreibt keine Chunks neu
//   - eine Metadaten-Änderung (updated_at springt, Text gleich) schreibt keine
//     Chunks neu, zieht aber den Index-Stempel nach (staleCount → 0)
//   - verschobene Chunk-Grenzen: unveränderte Chunks behalten ihren Vektor
//     (Hash-Wiederverwendung unabhängig von der Position)
//   - eine falsch eingestellte Dimension bricht mit eigenem Fehler ab

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

const MODEL = 'test-embed';
const OWNER = 'quellen-owner@test.dev';

let ctx, db, schema, embed, sourceChunks, sourceIndex, shared, embedChunk;
let embedCalls = 0;
let embeddedTexts = [];
let dim = 3;

function fakeVec(text, n) {
  const v = new Float32Array(n);
  for (let i = 0; i < text.length; i++) v[i % n] += text.charCodeAt(i) % 7;
  v[0] += 1;
  return v;
}

test.before(() => {
  ctx = bootstrap();
  schema = require('../../db/schema');
  db = schema.db;
  embed = require('../../lib/embed');
  embed.isEnabled = () => true;
  embed.getConfig = () => ({ model: MODEL, dim: 3, passagePrefix: '' });
  embed.embedBatch = async (texts) => {
    embedCalls++;
    embeddedTexts.push(...texts);
    return texts.map(t => fakeVec(t, dim));
  };
  embedChunk = require('../../lib/embed-chunk');
  sourceChunks = require('../../db/source-semantic-chunks');
  sourceIndex = require('../../routes/jobs/source-embed-index');
  shared = require('../../routes/jobs/shared');
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Owner' });
});
test.after(() => ctx.cleanup());

let source;
test.beforeEach(() => {
  db.prepare('DELETE FROM source_semantic_chunks').run();
  db.prepare('DELETE FROM sources WHERE owner_email = ?').run(OWNER);
  embedCalls = 0;
  embeddedTexts = [];
  dim = 3;
  source = schema.createSource(OWNER, { csl_type: 'book', title: 'Werk' });
  setText('Der Leuchtturm steht am Kap. Die Bucht liegt im Norden.');
});

function setText(text) {
  schema.setSourceDoc(source.id, {
    mime: 'application/pdf', name: 'werk.pdf', text,
    pages: 1, chars: text.length, hash: embedChunk.contentHash(text), buffer: Buffer.from('%PDF-1.4 x'),
  });
}

async function runIndex() {
  const jobId = sourceIndex.enqueueSourceEmbedIndexJob(OWNER);
  assert.ok(jobId);
  return waitForJob(shared, jobId, { timeoutMs: 10000 });
}

const chunkRows = () => db.prepare(
  'SELECT rowid, chunk_ix, content_hash, created_at FROM source_semantic_chunks WHERE source_id = ? ORDER BY chunk_ix'
).all(source.id);

test('Erstlauf indiziert und stempelt doc_indexed_at', async () => {
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  assert.ok(chunkRows().length > 0);
  assert.ok(schema.getSourceDocMeta(source.id).doc_indexed_at);
  assert.equal(sourceChunks.indexStatus(OWNER, MODEL).staleCount, 0);
});

test('zweiter Lauf ohne Änderung: kein Embedding, keine neu geschriebenen Chunks', async () => {
  await runIndex();
  const before = chunkRows();
  const stampBefore = schema.getSourceDocMeta(source.id).doc_indexed_at;
  embedCalls = 0;
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  assert.equal(embedCalls, 0);
  assert.deepEqual(chunkRows(), before);
  // Nicht stale → der Stempel bleibt stehen (kein Schreiben je Nachtlauf).
  assert.equal(schema.getSourceDocMeta(source.id).doc_indexed_at, stampBefore);
});

test('Metadaten-Edit: keine Chunks neu, Index-Stempel nachgezogen', async () => {
  await runIndex();
  const before = chunkRows();
  // Stempel älter als updated_at (wie nach einem Titel-Edit), Text unverändert.
  db.prepare("UPDATE sources SET doc_indexed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(source.id);
  assert.equal(sourceChunks.indexStatus(OWNER, MODEL).staleCount, 1);
  embedCalls = 0;
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  assert.equal(embedCalls, 0);
  assert.deepEqual(chunkRows(), before);
  assert.equal(sourceChunks.indexStatus(OWNER, MODEL).staleCount, 0);
});

test('verschobene Chunk-Grenzen: bekannte Chunks werden nicht neu embeddet', async () => {
  // Mehrere Chunks erzwingen: Absätze aus vielen Sätzen.
  const para = (n) => Array.from({ length: 60 }, (_, i) => `Satz ${n}-${i} über den Leuchtturm am Kap.`).join(' ');
  const body = [para(1), para(2), para(3), para(4)].join('\n\n');
  setText(body);
  await runIndex();
  const firstChunks = embedChunk.chunkText(body);
  assert.ok(firstChunks.length >= 2, 'Test braucht mehrere Chunks');
  embeddedTexts = [];
  // Einen kompletten Chunk vorne einfügen → alle bisherigen Chunks rutschen
  // eine Position weiter, ihr Text bleibt gleich.
  const shifted = firstChunks[0] + '\n\n' + body;
  const nextChunks = embedChunk.chunkText(shifted);
  setText(shifted);
  const job = await runIndex();
  assert.equal(job.status, 'done', job.error);
  const known = new Set(firstChunks);
  const reEmbedded = embeddedTexts.filter(t => known.has(t));
  assert.equal(reEmbedded.length, 0, 'bekannte Chunks dürfen nicht neu embeddet werden');
  assert.equal(chunkRows().length, nextChunks.length);
});

test('falsche Dimension: Abbruch mit eigenem Fehler, nichts geschrieben', async () => {
  dim = 4;
  const job = await runIndex();
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /embedDimMismatch/);
  assert.equal(chunkRows().length, 0);
  assert.equal(schema.getSourceDocMeta(source.id).doc_indexed_at, null);
});

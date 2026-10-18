// rerankOrder (lib/semantic-retrieval.js): generisches Reorder-Primitiv für Pfade
// mit eigenem Retrieval (Buch-Chat-FTS-Literalsuche). Deckt die Reihenfolge-Logik
// ab (Ranked-Spitze + angehängter, nicht gerankter Rest = voller Recall) und die
// Non-fatal-Fallbacks. rerank.js wird über den Require-Cache gemockt (kein Netz).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('rerankorder');

const require = createRequire(import.meta.url);
const rerank = require('../../lib/rerank.js');
const { rerankOrder } = require('../../lib/semantic-retrieval.js');

function mockRerank({ enabled = true, topN = 30, minScore = 0, fn = null } = {}) {
  rerank.isEnabled = () => enabled;
  rerank.getConfig = () => ({ topN, minScore });
  rerank.rerank = fn || (async () => []);
}

test('rerankOrder: reordnet den Pool und hängt nicht gerankte Reste an', async () => {
  // 4 Docs, Reranker ordnet nur die ersten 3 (topN=3) → Rest-Index 3 bleibt am Ende.
  mockRerank({
    topN: 3,
    fn: async (q, docs) => {
      assert.equal(q, 'query');
      assert.equal(docs.length, 3);
      return [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
    },
  });
  const order = await rerankOrder('query', ['a', 'b', 'c', 'd']);
  assert.deepEqual(order, [2, 0, 1, 3]);
});

test('rerankOrder: Backend liefert nur Teilmenge → fehlende Pool-Indizes landen im Rest', async () => {
  mockRerank({ topN: 30, fn: async () => [{ index: 1, score: 0.8 }] });
  const order = await rerankOrder('q', ['a', 'b', 'c']);
  // Index 1 gerankt, 0 und 2 als Rest in Original-Reihenfolge dahinter.
  assert.deepEqual(order, [1, 0, 2]);
});

test('rerankOrder: Rerank aus → null (Aufrufer behält Reihenfolge)', async () => {
  mockRerank({ enabled: false });
  assert.equal(await rerankOrder('q', ['a', 'b']), null);
});

test('rerankOrder: < 2 Docs oder leerer Query → null', async () => {
  mockRerank({ enabled: true });
  assert.equal(await rerankOrder('q', ['a']), null);
  assert.equal(await rerankOrder('   ', ['a', 'b']), null);
});

test('rerankOrder: Backend-Fehler ist non-fatal → null', async () => {
  mockRerank({ fn: async () => { throw new Error('endpoint down'); } });
  assert.equal(await rerankOrder('q', ['a', 'b']), null);
});

test('rerankOrder: AbortError propagiert (Job-Cancel)', async () => {
  mockRerank({ fn: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  await assert.rejects(() => rerankOrder('q', ['a', 'b']), /aborted/);
});

// semanticQuery mit aktivem Reranker: der Cross-Encoder bewertet nur die Spitze
// (top_n), der Rest hängt in Retrieval-Reihenfolge an — sonst deckelte der
// Reranker jede Anfrage auf top_n (Motiv-Scan verlangt bis zu 500 Fundstellen).
const embed = require('../../lib/embed.js');
const semanticChunks = require('../../db/semantic-chunks.js');
const searchIndex = require('../../lib/search.js');
const { semanticQuery } = require('../../lib/semantic-retrieval.js');

function mockRetrieval(n) {
  const seen = {};
  embed.getConfig = () => ({ model: 'm' });
  embed.embedQuery = async () => [1, 0];
  semanticChunks.searchSimilar = (bookId, model, vec, opts) => {
    seen.topK = opts.topK;
    return Array.from({ length: Math.min(n, opts.topK) }, (_, i) => ({
      kind: 'page', entity_id: i + 1, text: `t${i + 1}`, score: 0.9 - i * 0.001,
    }));
  };
  searchIndex.query = () => ({ hits: [] });
  return seen;
}

test('semanticQuery: Rerank deckelt nicht auf top_n — Rest hängt ungeprüft an', async () => {
  const seen = mockRetrieval(200);
  mockRerank({
    topN: 3,
    fn: async (q, docs) => {
      assert.equal(docs.length, 3);
      return [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
    },
  });
  const hits = await semanticQuery(1, 'frage', { topK: 150 });
  assert.equal(seen.topK, 150, 'Retrieval-Pool nie kleiner als topK');
  assert.equal(hits.length, 150);
  assert.deepEqual(hits.slice(0, 5).map(h => h.entity_id), [3, 1, 2, 4, 5]);
  assert.equal(hits[3].score, 0);
});

test('semanticQuery: rerank.min_score > 0 ist ein Tor — ungeprüfter Rest kommt nicht durch', async () => {
  mockRetrieval(10);
  mockRerank({
    topN: 3, minScore: 0.3,
    fn: async () => [{ index: 2, score: 0.9 }, { index: 0, score: 0.2 }, { index: 1, score: 0.1 }],
  });
  const hits = await semanticQuery(1, 'frage', { topK: 5 });
  assert.deepEqual(hits.map(h => h.entity_id), [3]);
});

// strictRerank: speichernde Anker-Jobs (Motiv-Scan, Beat-/Figuren-Anker) dürfen
// bei Reranker-Ausfall nicht still die ungefilterte Retrieval-Liste bekommen,
// solange das Tor (min_score > 0) konfiguriert ist — sonst Full-Replace mit Rauschen.
test('semanticQuery strictRerank: Ausfall bei gesetztem Tor wirft', async () => {
  mockRetrieval(10);
  mockRerank({ topN: 3, minScore: 0.3, fn: async () => { const e = new Error('HTTP 500'); e.rerankDown = true; throw e; } });
  await assert.rejects(semanticQuery(1, 'frage', { topK: 5, strictRerank: true }), /500/);
  // Ohne strict: stiller Fallback auf die Retrieval-Reihenfolge (Such-Karte, Chats).
  const hits = await semanticQuery(1, 'frage', { topK: 5 });
  assert.equal(hits.length, 5);
});

test('semanticQuery strictRerank: ohne Tor (min_score 0) bleibt der Fallback still', async () => {
  mockRetrieval(10);
  mockRerank({ topN: 3, minScore: 0, fn: async () => { throw new Error('HTTP 500'); } });
  const hits = await semanticQuery(1, 'frage', { topK: 5, strictRerank: true });
  assert.equal(hits.length, 5);
});

// Mit Tor bewertet der Cross-Encoder den Pool bis topK, nicht nur top_n — sonst
// deckelte das Tor jeden Aufrufer auf top_n Treffer (Motiv-Scan bis 500).
test('semanticQuery: mit Tor wird der Pool bis topK bewertet, nicht nur top_n', async () => {
  mockRetrieval(10);
  let seenDocs = 0;
  mockRerank({
    topN: 3, minScore: 0.3,
    fn: async (q, docs) => { seenDocs = docs.length; return docs.map((_, i) => ({ index: i, score: 0.9 - i * 0.01 })); },
  });
  const hits = await semanticQuery(1, 'frage', { topK: 8 });
  assert.equal(seenDocs, 8);
  assert.equal(hits.length, 8);
  assert.ok(hits.every(h => typeof h.rerankScore === 'number'));
});

// rerankScore trennt bewertete von ungeprüft angehängten Kandidaten; ohne
// Reranker ist er null (Aufrufer prüfen das Tor gegen rerankScore, nie gegen score).
test('semanticQuery: rerankScore nur für bewertete Kandidaten', async () => {
  mockRetrieval(10);
  mockRerank({ topN: 2, minScore: 0, fn: async () => [{ index: 1, score: 0.7 }, { index: 0, score: 0.4 }] });
  const hits = await semanticQuery(1, 'frage', { topK: 4 });
  assert.deepEqual(hits.map(h => h.rerankScore), [0.7, 0.4, null, null]);
  mockRerank({ enabled: false });
  const plain = await semanticQuery(1, 'frage', { topK: 3 });
  assert.ok(plain.every(h => h.rerankScore === null));
});

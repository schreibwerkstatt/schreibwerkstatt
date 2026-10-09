'use strict';
// Unit (Temp-DB): lange Abschnitte (ein Kapitel am Stück, 20–60k Zeichen).
//  - searchSimilar: Default ein Treffer pro Entität; perEntity > 1 liefert
//    mehrere GETRENNTE Passagen (Nachbar-Chunks innerhalb minChunkGap fallen weg).
//  - fuseCandidates: jede Passage bleibt eigener Kandidat, ein FTS-Treffer
//    verschmilzt mit der besten Passage seiner Entität.
//  - selectPassagesSemantic (klassischer Buch-Chat-RAG): mehrere Passagen einer
//    Seite werden in Textreihenfolge zu EINEM Auszug gebündelt.
//  - get_pages / get_chapter_text: Fenster ab offset + next_offset; Durchblättern
//    liefert den ganzen Text, und der Ergebnis-Deckel kürzt das Fenster nie nach.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('semantic-multi-passage');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const semanticChunks = require('../../db/semantic-chunks');
const { fuseCandidates } = require('../../lib/semantic-fusion');
const semanticRetrieval = require('../../lib/semantic-retrieval');
const contentStore = require('../../lib/content-store');
const { selectPassagesSemantic } = require('../../routes/jobs/chat/book-chat-retrieval');
const { pageWindow } = require('../../routes/jobs/book-chat-tools/tools-text');
const { executeTool } = require('../../routes/jobs/book-chat-tools');

const MODEL = 'test-embed';
const DIM = 3;
const NOW = '2026-01-01T00:00:00.000Z';
const BOOK = 93501;
const CHAP = 93511;
const P_LONG = 935101;
const P_OTHER = 935102;

db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(BOOK, 'Lang', NOW, NOW);
db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?,?,?,?,?)').run(CHAP, BOOK, 'Kapitel Eins', 1, NOW);
for (const id of [P_LONG, P_OTHER]) {
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, position, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, BOOK, CHAP, `Abschnitt ${id}`, id - P_LONG, NOW);
}

// Query [1,0,0]. Scores: ix0 1.0 > ix1 ≈0.995 > ix2 ≈0.949 > ix4 ≈0.848 > ix3 ≈0.1
const LONG_VECS = [[1, 0, 0], [0.99, 0.1, 0], [0.9, 0.3, 0], [0.1, 1, 0], [0.8, 0.5, 0]];
semanticChunks.replaceEntity('page', P_LONG, BOOK, MODEL, DIM, LONG_VECS.map((v, ix) => ({
  chunk_ix: ix, content_hash: `l${ix}`, vector: Float32Array.from(v), text: `lang-${ix}`,
})));
semanticChunks.replaceEntity('page', P_OTHER, BOOK, MODEL, DIM, [
  { chunk_ix: 0, content_hash: 'o0', vector: Float32Array.from([0.7, 0.7, 0]), text: 'anders-0' },
]);
const Q = Float32Array.from([1, 0, 0]);
const ixOf = (hits, id) => hits.filter(h => h.entity_id === id).map(h => h.chunk_ix);

test('searchSimilar: Default ein Treffer (bester Chunk) pro Entität', () => {
  const hits = semanticChunks.searchSimilar(BOOK, MODEL, Q, { topK: 10 });
  assert.deepEqual(hits.map(h => [h.entity_id, h.chunk_ix]), [[P_LONG, 0], [P_OTHER, 0]]);
  assert.equal(hits[0].text, 'lang-0');
});

test('searchSimilar: perEntity 3 → getrennte Passagen, direkte Nachbarn fallen weg', () => {
  const hits = semanticChunks.searchSimilar(BOOK, MODEL, Q, { topK: 10, perEntity: 3 });
  assert.deepEqual(ixOf(hits, P_LONG), [0, 2, 4]);
  assert.deepEqual(ixOf(hits, P_OTHER), [0]);
  // nach Score absteigend, jede Passage mit eigenem Text
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.deepEqual(hits.filter(h => h.entity_id === P_LONG).map(h => h.text), ['lang-0', 'lang-2', 'lang-4']);
});

test('searchSimilar: minChunkGap 3 (Nachbar-Erweiterung ±1) und topK-Schnitt', () => {
  assert.deepEqual(ixOf(semanticChunks.searchSimilar(BOOK, MODEL, Q, { topK: 10, perEntity: 3, minChunkGap: 3 }), P_LONG), [0, 4]);
  const two = semanticChunks.searchSimilar(BOOK, MODEL, Q, { topK: 2, perEntity: 3 });
  assert.deepEqual(two.map(h => [h.entity_id, h.chunk_ix]), [[P_LONG, 0], [P_LONG, 2]]);
});

test('fuseCandidates: Passagen bleiben getrennt, FTS verschmilzt mit der besten', () => {
  const sem = [
    { kind: 'page', entity_id: 1, chunk_ix: 4, text: 'a', score: 0.9 },
    { kind: 'page', entity_id: 2, chunk_ix: 0, text: 'b', score: 0.8 },
    { kind: 'page', entity_id: 1, chunk_ix: 9, text: 'c', score: 0.7 },
  ];
  const fused = fuseCandidates(sem, [{ kind: 'page', entity_id: 1, title: 'T', snippet: 's' }, { kind: 'page', entity_id: 3, title: 'X', snippet: 'y' }]);
  assert.equal(fused.length, 4);
  const p1 = fused.filter(c => c.entity_id === 1);
  assert.deepEqual(p1.map(c => c.chunk_ix), [4, 9]);
  assert.equal(p1[0].ftsRank, 0);   // FTS-Treffer hängt an der besten Passage
  assert.equal(p1[1].ftsRank, null);
  assert.equal(fused[0].entity_id, 1);
  assert.equal(fused.find(c => c.entity_id === 3).chunk_ix, null);
});

test('selectPassagesSemantic: mehrere Passagen einer Seite → ein Auszug in Textreihenfolge', async () => {
  const orig = { ...semanticRetrieval };
  const origList = contentStore.listPages;
  let seenOpts = null;
  try {
    semanticRetrieval.indexReady = () => true;
    semanticRetrieval.semanticQuery = async (_b, _q, opts) => {
      seenOpts = opts;
      return [
        { kind: 'page', entity_id: P_LONG, chunk_ix: 8, text: 'Z'.repeat(80), score: 0.9 },
        { kind: 'page', entity_id: P_OTHER, chunk_ix: 0, text: 'O'.repeat(80), score: 0.8 },
        { kind: 'page', entity_id: P_LONG, chunk_ix: 2, text: 'A'.repeat(80), score: 0.7 },
      ];
    };
    semanticRetrieval.withNeighbors = (hits) => hits;
    contentStore.listPages = async () => [P_LONG, P_OTHER].map(id => ({ id, name: `Abschnitt ${id}`, slug: null, book_slug: null }));
    const r = await selectPassagesSemantic(BOOK, 'q', 10000);
    assert.equal(r.status, 'ok');
    assert.equal(seenOpts.perEntity, semanticRetrieval.PASSAGES_PER_ENTITY);
    assert.ok(seenOpts.perEntity > 1);
    assert.deepEqual(r.selectedPages.map(p => p.id), [P_LONG, P_OTHER]);
    assert.equal(r.selectedPages[0].text, `${'A'.repeat(80)}\n[…]\n${'Z'.repeat(80)}`);
    assert.equal(r.usedChars, 80 * 3 + '\n[…]\n'.length);
  } finally {
    Object.assign(semanticRetrieval, orig);
    contentStore.listPages = origList;
  }
});

test('pageWindow: Fenster, Wortgrenze, Offset hinter dem Ende', () => {
  const t = 'eins zwei drei vier fünf';
  assert.deepEqual(pageWindow(t, 0, 100), { text: t, page_chars: t.length, truncated: false });
  const w = pageWindow(t, 0, 12); // Schnitt in „drei" → zurück auf die Wortgrenze
  assert.equal(w.text, 'eins zwei');
  assert.equal(w.next_offset, 10);
  assert.equal(w.truncated, true);
  const w2 = pageWindow(t, w.next_offset, 12);
  assert.equal(w2.text, 'drei vier');
  assert.equal(w2.offset, 10);
  assert.deepEqual(pageWindow(t, 999, 10), { text: '', offset: t.length, page_chars: t.length, truncated: false, offset_beyond_end: true });
});

test('get_pages/get_chapter_text: Durchblättern per next_offset liefert den ganzen Abschnitt', async () => {
  const words = Array.from({ length: 3000 }, (_, i) => `wort${i}`);
  const full = words.join(' ');
  const origLoad = contentStore.loadPage;
  contentStore.loadPage = async (id) => ({ name: `Abschnitt ${id}`, html: id === P_LONG ? `<p>${full}</p>` : '<p>kurz</p>' });
  const ctx = { bookId: BOOK, userEmail: null, resultCapChars: 5000 };
  try {
    const pieces = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard++) {
      const r = await executeTool('get_pages', { ids: [P_LONG], offset, max_chars_per_page: 100000 }, ctx);
      assert.equal(r.truncated_fields, undefined, 'Deckel darf das Fenster nicht nachträglich kürzen');
      const p = r.pages[0];
      assert.equal(p.page_chars, full.length);
      assert.ok(p.text.length <= 5000);
      assert.equal(full.slice(offset, offset + p.text.length), p.text);
      pieces.push(p.text);
      if (!p.truncated) { assert.equal(p.next_offset, undefined); break; }
      assert.ok(r.hint);
      assert.ok(p.next_offset > offset);
      offset = p.next_offset;
    }
    assert.ok(pieces.length > 5);
    assert.equal(pieces.join(' '), full);

    const ch = await executeTool('get_chapter_text', { chapter_id: CHAP, offset: 20 }, ctx);
    const long = ch.pages.find(p => p.page_id === P_LONG);
    assert.equal(long.offset, 20);
    assert.equal(long.text, full.slice(20, 20 + long.text.length));
    assert.ok(long.next_offset > 20);
    const short = ch.pages.find(p => p.page_id === P_OTHER);
    if (short) assert.equal(short.text, '');
  } finally {
    contentStore.loadPage = origLoad;
  }
});

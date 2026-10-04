'use strict';
// RAG-Bausteine der Chats (routes/jobs/chat/book-chat-retrieval.js +
// routes/jobs/book-chat-tools/tools-similar.js): Suchtext aus Frage + letzter
// Runde, Erst-Kontext mit Nachbar-Chunks unter Zeichendeckel und Seiten-Ausschluss,
// „kein Index" vs. „keine Treffer" im klassischen Pfad, Snippet-Zentrierung und
// Offset-Rückrechnung von search_similar. semanticQuery/withNeighbors/indexReady
// sind am Modul-Export gemockt (die Module rufen sie über den Namespace).

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('chat-rag-retrieval');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');
const semanticRetrieval = require('../../lib/semantic-retrieval');
const contentStore = require('../../lib/content-store');
const {
  retrievalQuery, preContextPassages, selectPassagesSemantic,
} = require('../../routes/jobs/chat/book-chat-retrieval');
const { centeredSnippet, locateInPageText } = require('../../routes/jobs/book-chat-tools/tools-similar');

const BOOK = 92001;
const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(BOOK, 'RAG-Buch', now, now);
for (const id of [92011, 92012, 92013]) {
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?,?,?,?)').run(id, BOOK, `Seite ${id}`, now);
}

const orig = {
  semanticQuery: semanticRetrieval.semanticQuery,
  withNeighbors: semanticRetrieval.withNeighbors,
  indexReady: semanticRetrieval.indexReady,
  listPages: contentStore.listPages,
};
test.afterEach(() => Object.assign(semanticRetrieval, {
  semanticQuery: orig.semanticQuery, withNeighbors: orig.withNeighbors, indexReady: orig.indexReady,
}));
test.after(() => { contentStore.listPages = orig.listPages; });

const LONG = 'x'.repeat(200);
const hit = (id, text) => ({ kind: 'page', entity_id: id, chunk_ix: 1, text, score: 0.5 });

test('retrievalQuery: Folgefrage trägt Vorfrage + Antwortanfang, i18n-Marker zählen nicht', () => {
  const q = retrievalQuery('und wie alt war sie da?', [
    { role: 'user', content: 'Wann hat Anna geheiratet?' },
    { role: 'assistant', content: 'Anna heiratete 1952.' },
  ]);
  assert.match(q, /Anna geheiratet/);
  assert.match(q, /1952/);
  assert.match(q, /wie alt war sie da/);
  const q2 = retrievalQuery('Frage', [{ role: 'assistant', content: '__i18n:chat.errors.emptyAnswer__' }]);
  assert.equal(q2, 'Frage');
});

test('preContextPassages: Nachbarn, aktuelle Seite ausgeschlossen, Deckel fällt auf den Treffer-Chunk zurück', async () => {
  appSettings.set('jobs.book_chat.pre_rag_top_k', 8);
  let askedTopK = null;
  semanticRetrieval.semanticQuery = async (_b, _q, opts) => {
    askedTopK = opts.topK;
    assert.ok(opts.kinds.includes('location') && opts.kinds.includes('fact'));
    return [hit(92011, `A${LONG}`), hit(92012, `B${LONG}`), hit(92013, `C${LONG}`)];
  };
  // Nachbarschaft nur für 92012 zu gross → dort bleibt der Treffer-Chunk.
  semanticRetrieval.withNeighbors = (hits) => hits.map(h => ({
    ...h, text: h.entity_id === 92012 ? `${'n'.repeat(5000)}${h.text}` : `vor ${h.text} nach`,
  }));
  const pre = await preContextPassages(BOOK, 'frage', { chars: 1000, excludePageIds: [92011], userEmail: null });
  assert.equal(askedTopK, 9, 'ausgeschlossene Seiten werden über topK nachgezogen');
  assert.deepEqual(pre.hits.map(h => h.entity_id), [92012, 92013]);
  assert.equal(pre.hits[0].text, `B${LONG}`, 'zu grosse Nachbarschaft → Treffer-Chunk');
  assert.equal(pre.hits[1].text, `vor C${LONG} nach`);
  assert.ok(pre.chars <= 1000);
});

test('preContextPassages: top_k 0 schaltet ab', async () => {
  semanticRetrieval.semanticQuery = async () => { throw new Error('darf nicht laufen'); };
  assert.equal(await preContextPassages(BOOK, 'q', { topK: 0 }), null);
});

test('selectPassagesSemantic: unvollständiger Index → no_index ohne Anfrage, sonst no_hits/ok', async () => {
  semanticRetrieval.indexReady = () => false;
  semanticRetrieval.semanticQuery = async () => { throw new Error('darf nicht laufen'); };
  assert.deepEqual(await selectPassagesSemantic(BOOK, 'q', 10000), { status: 'no_index' });

  semanticRetrieval.indexReady = () => true;
  semanticRetrieval.semanticQuery = async () => [];
  assert.deepEqual(await selectPassagesSemantic(BOOK, 'q', 10000), { status: 'no_hits' });

  semanticRetrieval.semanticQuery = async () => [hit(92011, `A${LONG}`)];
  semanticRetrieval.withNeighbors = (hits) => hits.map(h => ({ ...h, text: `vor ${h.text}` }));
  contentStore.listPages = async () => [{ id: 92011, name: 'Seite 92011', slug: 's', book_slug: 'b' }];
  const r = await selectPassagesSemantic(BOOK, 'q', 10000);
  assert.equal(r.status, 'ok');
  assert.equal(r.selectedPages[0].text, `vor A${LONG}`);
});

test('centeredSnippet: kurzer Chunk ganz, langer um den passendsten Satz', () => {
  assert.equal(centeredSnippet('Kurz.', 'egal', 700).snippet, 'Kurz.');
  const filler = 'Es regnete den ganzen Tag ohne Pause. '.repeat(30);
  const text = `${filler}Am Bahnhof nahm Lena Abschied von ihrem Bruder. ${filler}`;
  const { snippet } = centeredSnippet(text, 'Abschied am Bahnhof', 300);
  assert.match(snippet, /Abschied von ihrem Bruder/);
  assert.ok(snippet.length <= 302);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  // Ohne Anfrage-Treffer: Chunk-Anfang.
  assert.ok(centeredSnippet(text, 'zzzz qqqq', 300).snippet.startsWith('Es regnete'));
});

test('locateInPageText: Offsets im nicht kollabierten Seitentext, Anfangs-Probe als Rückfall', () => {
  const page = 'Erster Absatz.\n\nZweiter   Absatz mit\nUmbruch und mehr Text danach.';
  const loc = locateInPageText(page, 'Zweiter Absatz mit Umbruch und mehr');
  assert.ok(loc);
  assert.equal(page.slice(loc.offset, loc.offset + loc.length).replace(/\s+/g, ' '), 'Zweiter Absatz mit Umbruch und mehr');
  // Ende seit dem Indexlauf editiert → Anfang trägt noch.
  const loc2 = locateInPageText(page, 'Zweiter Absatz mit Umbruch und mehr Text, inzwischen anders');
  assert.ok(loc2);
  assert.equal(loc2.offset, page.indexOf('Zweiter'));
  assert.equal(locateInPageText(page, 'kommt so nirgends auf der Seite vor'), null);
});

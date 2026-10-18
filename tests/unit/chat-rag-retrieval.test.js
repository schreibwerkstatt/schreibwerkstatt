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
const { indexIncompleteFields } = require('../../routes/jobs/book-chat-tools/shared');
const { FALLBACK_PLACEHOLDER } = require('../../routes/jobs/agentic-chat/history');

const BOOK = 92001;
const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(BOOK, 'RAG-Buch', now, now);
for (const id of [92011, 92012, 92013]) {
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?,?,?,?)').run(id, BOOK, `Seite ${id}`, now);
}

const orig = {
  semanticQuery: semanticRetrieval.semanticQuery,
  withNeighbors: semanticRetrieval.withNeighbors,
  indexState: semanticRetrieval.indexState,
  listPages: contentStore.listPages,
  loadPagesBatch: contentStore.loadPagesBatch,
};
test.afterEach(() => {
  Object.assign(semanticRetrieval, {
    semanticQuery: orig.semanticQuery, withNeighbors: orig.withNeighbors, indexState: orig.indexState,
  });
  Object.assign(contentStore, { listPages: orig.listPages, loadPagesBatch: orig.loadPagesBatch });
});
// Index vollständig, Lauf nach allen Seiten-Stempeln — sofern ein Test nichts anderes setzt.
const INDEXED_AT = new Date(Date.now() + 60_000).toISOString();
const readyIndex = () => { semanticRetrieval.indexState = () => ({ ready: true, lastIndexedAt: INDEXED_AT }); };

const LONG = 'x'.repeat(200);
const hit = (id, text) => ({ kind: 'page', entity_id: id, chunk_ix: 1, text, score: 0.031, semScore: 0.6234 });

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
  // buildAgenticHistory ersetzt Marker durch den Platzhalter — dann trägt die letzte echte Antwort.
  const q3 = retrievalQuery('Folgefrage', [
    { role: 'user', content: 'Wer ist Anna?' },
    { role: 'assistant', content: 'Anna ist die Schwester von Tom.' },
    { role: 'user', content: 'Und weiter?' },
    { role: 'assistant', content: FALLBACK_PLACEHOLDER },
  ]);
  assert.match(q3, /Schwester von Tom/);
  assert.doesNotMatch(q3, /Keine inhaltliche Antwort/);
});

test('preContextPassages: Nachbarn, aktuelle Seite ausgeschlossen, Deckel fällt auf den Treffer-Chunk zurück', async () => {
  appSettings.set('jobs.book_chat.pre_rag_top_k', 8);
  readyIndex();
  let askedTopK = null;
  let askedUser;
  semanticRetrieval.semanticQuery = async (_b, _q, opts) => {
    askedTopK = opts.topK;
    askedUser = opts.user;
    assert.ok(opts.kinds.includes('location') && opts.kinds.includes('fact'));
    return [hit(92011, `A${LONG}`), hit(92012, `B${LONG}`), hit(92013, `C${LONG}`)];
  };
  // Nachbarschaft nur für 92012 zu gross → dort bleibt der Treffer-Chunk.
  semanticRetrieval.withNeighbors = (hits) => hits.map(h => ({
    ...h, text: h.entity_id === 92012 ? `${'n'.repeat(5000)}${h.text}` : `vor ${h.text} nach`,
  }));
  const pre = await preContextPassages(BOOK, 'frage', { chars: 1000, excludePageIds: [92011], userEmail: 'a@x.ch' });
  assert.equal(askedTopK, 9, 'ausgeschlossene Seiten werden über topK nachgezogen');
  assert.equal(askedUser, 'a@x.ch', 'User-Scope geht an die Pipeline (vor topK)');
  assert.equal(pre.indexIncomplete, false);
  // Stabile Relevanz statt Stufen-Score: Rang + Cosinus, kein RRF-`score`.
  assert.equal(pre.hits[0].rank, 1);
  assert.equal(pre.hits[0].similarity, 0.62);
  assert.equal('score' in pre.hits[0], false);
  assert.deepEqual(pre.hits.map(h => h.entity_id), [92012, 92013]);
  assert.equal(pre.hits[0].text, `B${LONG}`, 'zu grosse Nachbarschaft → Treffer-Chunk');
  assert.equal(pre.hits[1].text, `vor C${LONG} nach`);
  assert.ok(pre.chars <= 1000);
});

test('preContextPassages: top_k 0 schaltet ab', async () => {
  semanticRetrieval.semanticQuery = async () => { throw new Error('darf nicht laufen'); };
  assert.equal(await preContextPassages(BOOK, 'q', { topK: 0 }), null);
});

test('preContextPassages: Seiten nach dem Indexlauf geändert → indexIncomplete, auch ohne Treffer', async () => {
  semanticRetrieval.indexState = () => ({ ready: true, lastIndexedAt: '2000-01-01T00:00:00.000Z' });
  semanticRetrieval.semanticQuery = async () => [];
  const pre = await preContextPassages(BOOK, 'frage', { topK: 4, chars: 1000 });
  assert.deepEqual(pre.hits, []);
  assert.equal(pre.indexIncomplete, true);
  assert.equal(pre.stalePages, 3);
  const f = indexIncompleteFields({ ready: true, incomplete: true, changedPageIds: [1, 2] });
  assert.equal(f.index_incomplete, true);
  assert.match(f.index_hint, /2 Abschnitt/);
  assert.deepEqual(indexIncompleteFields({ ready: true, incomplete: false, changedPageIds: [] }), {});
});

const WORDS = 'Am Morgen ging Lena zum Bahnhof und wartete lange auf den Zug nach Bern, der nicht kam.';
const meta = (id, updated_at = now) => ({ id, name: `Seite ${id}`, slug: 's', book_slug: 'b', updated_at });

test('selectPassagesSemantic: unvollständiger Index → no_index ohne Anfrage, sonst no_hits/ok', async () => {
  contentStore.listPages = async () => [meta(92011)];
  semanticRetrieval.indexState = () => ({ ready: false, lastIndexedAt: null });
  semanticRetrieval.semanticQuery = async () => { throw new Error('darf nicht laufen'); };
  assert.deepEqual(await selectPassagesSemantic(BOOK, 'q', 10000), { status: 'no_index' });

  readyIndex();
  semanticRetrieval.semanticQuery = async () => [];
  assert.deepEqual(await selectPassagesSemantic(BOOK, 'q', 10000), { status: 'no_hits' });

  semanticRetrieval.semanticQuery = async () => [hit(92011, WORDS)];
  semanticRetrieval.withNeighbors = (hits) => hits;
  contentStore.loadPagesBatch = async (metas) => metas.map(m => ({ id: m.id, html: `<p>Vorher.</p><p>${WORDS}</p>` }));
  const r = await selectPassagesSemantic(BOOK, 'q', 10000);
  assert.equal(r.status, 'ok');
  assert.match(r.selectedPages[0].text, /wartete lange auf den Zug nach Bern/);
});

test('selectPassagesSemantic: Live-Text statt Index-Text, gelöschte Stelle fällt weg, frische Seite per Keyword', async () => {
  // 92013 nach dem Indexlauf bearbeitet → kommt per scoreText dazu.
  semanticRetrieval.indexState = () => ({ ready: true, lastIndexedAt: '2026-01-01T00:00:00.000Z' });
  contentStore.listPages = async () => [
    meta(92011, '2025-12-01T00:00:00.000Z'), meta(92012, '2025-12-01T00:00:00.000Z'), meta(92013, '2026-02-01T00:00:00.000Z'),
  ];
  semanticRetrieval.semanticQuery = async () => [hit(92011, WORDS), hit(92012, 'Ein völlig anderer Satz über Katzen, die im Garten schlafen und träumen.')];
  semanticRetrieval.withNeighbors = (hits) => hits;
  const live = {
    92011: `<p>${WORDS.replace('lange', 'sehr lange')}</p>`,      // leicht bearbeitet → live abgebildet
    92012: '<p>Die Stelle ist komplett umgeschrieben worden, nichts davon steht noch hier.</p>',
    92013: '<p>Neu geschrieben: Lena fährt mit dem Velo nach Bern und lacht.</p>',
  };
  contentStore.loadPagesBatch = async (metas) => metas.map(m => ({ id: m.id, html: live[m.id] }));
  const scoreText = (q, text) => (text.includes('Velo') ? 3 : 0);
  const r = await selectPassagesSemantic(BOOK, 'Velo', 10000, null, { scoreText });
  assert.equal(r.status, 'ok');
  const byId = new Map(r.selectedPages.map(p => [p.id, p.text]));
  assert.match(byId.get(92011), /sehr lange/, 'Live-Fassung, nicht der Index-Chunk');
  assert.equal(byId.has(92012), false, 'umgeschriebene Stelle → kein veralteter Text');
  assert.match(byId.get(92013), /Velo/);
  assert.equal(r.freshPages, 1);
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

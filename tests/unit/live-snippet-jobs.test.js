'use strict';
// Live-Text statt Index-Chunk: Fundstellen-Auszüge der Ist-Index-Jobs
// (lib/anchor-snippet.js) und die Textbelege der Figuren-Werkstatt werden aus dem
// AKTUELLEN Seitentext geschnitten; steht die Stelle so nicht mehr auf der Seite,
// fällt der Treffer weg. Dazu: ein während des Laufs gelöschter Draft/Motiv lässt
// den Full-Replace still ausfallen statt am FK zu scheitern.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('live-snippet-jobs');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const retrieval = require('../../lib/semantic-retrieval');
const { makeLiveSnippets } = require('../../lib/anchor-snippet');

const USER = 'live@example.com';
const BOOK = 81301, OTHER = 81302;
const NOW = '2026-01-01T00:00:00.000Z';
appUsers.createUser({ email: USER });
for (const b of [BOOK, OTHER]) db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'B', ?, ?)`).run(b, NOW, NOW);
const ch = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'K').lastInsertRowid;
const chO = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(OTHER, 'K').lastInsertRowid;
const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
const P_LIVE = 8130101, P_GONE = 8130102, P_FOREIGN = 8130103;
insPage.run(P_LIVE, BOOK, ch, 'Eins', '<p>Der Morgen war kalt.</p><p>Anna stand am Fenster und dachte an ihren Bruder, der nie zurueckkam.</p>', NOW);
insPage.run(P_GONE, BOOK, ch, 'Zwei', '<p>Ganz neuer Text ueber Maschinen und Fabriken heute.</p>', NOW);
insPage.run(P_FOREIGN, OTHER, chO, 'Fremd', '<p>Anna stand am Fenster und dachte an ihren Bruder.</p>', NOW);

test('makeLiveSnippets: Seiten-Auszug aus dem Live-Text, umgeschriebene/fremde Seite → null, Szene → Chunk', async () => {
  const snip = makeLiveSnippets(BOOK);
  // veralteter Chunk (alte Schreibweise) → Live-Satz
  const s = await snip({ kind: 'page', entity_id: P_LIVE, text: 'Anna stand am Fenster und dachte an ihren Bruder, der nie zurückkam.' });
  assert.match(s, /Anna stand am Fenster/);
  assert.match(s, /zurueckkam/, 'Live-Schreibweise, nicht Chunk-Text');
  assert.equal(await snip({ kind: 'page', entity_id: P_GONE, text: 'Anna stand am Fenster und dachte an ihren Bruder' }), null);
  assert.equal(await snip({ kind: 'page', entity_id: P_FOREIGN, text: 'Anna stand am Fenster und dachte an ihren Bruder' }), null);
  assert.equal(await snip({ kind: 'scene', entity_id: 5, text: '<b>Szene</b>: Anna am Fenster' }), 'Szene: Anna am Fenster');
});

test('Figuren-Werkstatt-Textbelege: nur Seiten, user-skopiert, Live-Text, nicht mehr vorhandene Stelle fällt weg', async () => {
  const embed = require('../../lib/embed');
  const origEnabled = embed.isEnabled;
  const origQuery = retrieval.semanticQuery;
  let opts = null;
  embed.isEnabled = () => true;
  retrieval.semanticQuery = async (_b, _q, o) => {
    opts = o;
    return [
      { kind: 'page', entity_id: P_GONE, text: 'Anna stand am Fenster und dachte an ihren Bruder', semScore: 0.9 },
      { kind: 'page', entity_id: P_LIVE, text: 'Anna stand am Fenster und dachte an ihren Bruder, der nie zurückkam.', semScore: 0.8 },
    ];
  };
  try {
    delete require.cache[require.resolve('../../routes/jobs/figur-werkstatt')];
    const { _loadFigurTextbelege } = require('../../routes/jobs/figur-werkstatt');
    const out = await _loadFigurTextbelege({ id: 1, book_id: BOOK, name: 'Anna', archetype: '' }, USER, null, undefined);
    assert.deepEqual(opts.kinds, ['page']);
    assert.equal(opts.user, USER);
    assert.equal(out.length, 1);
    assert.equal(out[0].page_id, P_LIVE);
    assert.match(out[0].snippet, /zurueckkam/);
  } finally {
    embed.isEnabled = origEnabled;
    retrieval.semanticQuery = origQuery;
    delete require.cache[require.resolve('../../routes/jobs/figur-werkstatt')];
  }
});

test('Ist-Index-Writes: gelöschtes Motiv / gelöschter Draft → false statt FK-Fehler', () => {
  const motifs = require('../../db/motifs');
  const occ = require('../../db/draft-figure-occurrences');
  const row = { kind: 'page', pageId: P_LIVE, score: 0.5, snippet: 'x', source: 'semantic' };
  assert.equal(motifs.replaceOccurrences(99999999, BOOK, [row]), false);
  assert.equal(occ.replaceKernOccurrences(99999999, BOOK, 'lie', [row]), false);
});

test('figur-anchor/_anchorKern: Suche user-skopiert, Live-Auszug, verschwundene Stelle verworfen', async () => {
  const origQuery = retrieval.semanticQuery;
  let opts = null;
  retrieval.semanticQuery = async (_b, _q, o) => {
    opts = o;
    return [
      { kind: 'page', entity_id: P_LIVE, text: 'Anna stand am Fenster und dachte an ihren Bruder', semScore: 0.7 },
      { kind: 'page', entity_id: P_GONE, text: 'Anna stand am Fenster und dachte an ihren Bruder', semScore: 0.6 },
    ];
  };
  try {
    delete require.cache[require.resolve('../../routes/jobs/figur-anchor')];
    const { _anchorKern } = require('../../routes/jobs/figur-anchor');
    const rows = await _anchorKern(BOOK, 'Anna. Wunde', () => undefined, 0, USER, makeLiveSnippets(BOOK));
    assert.equal(opts.user, USER);
    assert.deepEqual(rows.map(r => r.pageId), [P_LIVE]);
    assert.match(rows[0].snippet, /Anna stand am Fenster/);
  } finally {
    retrieval.semanticQuery = origQuery;
    delete require.cache[require.resolve('../../routes/jobs/figur-anchor')];
  }
});

// Werkzeug-Katalog der agentischen Chats (routes/jobs/chat-tools/): geteilte
// Helfer und ihre Anwendung in den Handlern, gegen eine Wegwerf-DB.
//  - Kapitel-Filter meinen den Teilbaum (list_ideen), stale der Kapitelbewertung
//    ebenso (die Bewertung umfasst die Unterkapitel).
//  - Namens-Lookup: Umlaute gross/klein, exakt > Wortanfang > Teilstring,
//    mehrdeutig → ambiguousName statt still der erste.
//  - Scope: fremde chapter_id/page_id → chapterNotInBook/pageNotInBook statt
//    still leerer Liste.
//  - Parameter wie limit:"viele" fallen auf den Default statt NaN.
//  - FTS-Fehler in list_research_items → search_failed statt ungefiltert.
//  - Erwähnungssumme nur aus Abschnitten desselben Buchs.
//  - Summen vor Listen (Plot-Board, Motiv-Übersicht).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('chat-tools-scope-lookup');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const ideenDb = require('../../db/ideen');
const plot = require('../../db/plot');
const researchItems = require('../../db/research-items');
const searchIndex = require('../../lib/search');
const { db } = require('../../db/connection');
const { executeTool } = require('../../routes/jobs/chat-tools');
const { findByName, groupBy, assertScope, clampInt } = require('../../routes/jobs/chat-tools/shared');

const USER = 'scope@x.test';
const BOOK = 771301;
const OTHER_BOOK = 771302;
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-03-01T00:00:00.000Z';

appUsers.createUser({ email: USER, displayName: 'Scope' });
schema.upsertBookByName(BOOK, 'Scope-Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Anderes Buch');

const insChapter = db.prepare('INSERT INTO chapters (book_id, chapter_name, parent_chapter_id, position) VALUES (?, ?, ?, ?)');
const chTop = insChapter.run(BOOK, 'Teil Eins', null, 1).lastInsertRowid;
const chSub = insChapter.run(BOOK, 'Unterkapitel', chTop, 2).lastInsertRowid;
const chForeign = insChapter.run(OTHER_BOOK, 'Fremd', null, 1).lastInsertRowid;
const insPage = db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
const P_TOP = 7713011, P_SUB = 7713012, P_FOREIGN = 7713021;
insPage.run(P_TOP, BOOK, chTop, 'Anfang', '<p>Es war einmal.</p>', NOW);
insPage.run(P_SUB, BOOK, chSub, 'Mitte', '<p>Dann geschah es.</p>', LATER);
insPage.run(P_FOREIGN, OTHER_BOOK, chForeign, 'Fremd', '<p>x</p>', NOW);

const ctx = () => ({ bookId: BOOK, userEmail: USER, logger: { info() {}, warn() {} } });
const run = (name, input) => executeTool(name, input, ctx());

// ── Helfer ───────────────────────────────────────────────────────────────────

test('findByName: Umlaute, Rangfolge, Mehrdeutigkeit', () => {
  const rows = [
    { id: 1, name: 'Österreich-Haus' },
    { id: 2, name: 'Hannah' },
    { id: 3, name: 'Anna Weber' },
    { id: 4, name: 'Annette' },
    { id: 5, name: 'Wald' },
  ];
  assert.equal(findByName(rows, 'ÖSTERREICH').row?.id, 1);
  assert.equal(findByName(rows, 'haus').row?.id, 1);
  assert.equal(findByName(rows, 'wald').row?.id, 5);
  // Wortanfang schlägt Teilstring: «weber» ist Wortanfang nur bei Anna Weber.
  assert.equal(findByName(rows, 'weber').row?.id, 3);
  // «ann»: Wortanfang bei Anna Weber und Annette → mehrdeutig (Hannah zählt nicht).
  const amb = findByName(rows, 'ann');
  assert.equal(amb.row, null);
  assert.deepEqual(amb.ambiguous.map(r => r.id), [3, 4]);
  // «nah»: nur Teilstring bei Hannah → eindeutig.
  assert.equal(findByName(rows, 'nah').row?.id, 2);
  assert.equal(findByName(rows, 'xyz').row, null);
  assert.equal(findByName(rows, '  ').row, null);
  // Mehrere Felder: bester Rang zählt.
  assert.equal(findByName([{ id: 9, name: 'Dr. X', kurz: 'Paul' }], 'paul', ['name', 'kurz']).row?.id, 9);
});

test('groupBy: Map key → Liste, Reihenfolge stabil', () => {
  const m = groupBy([{ k: 1, v: 'a' }, { k: 2, v: 'b' }, { k: 1, v: 'c' }], r => r.k, r => r.v);
  assert.deepEqual([...m.entries()], [[1, ['a', 'c']], [2, ['b']]]);
});

test('clampInt: Strings, Unsinn, Grenzen', () => {
  assert.equal(clampInt('viele', 50, 1, 200), 50);
  assert.equal(clampInt('7', 50, 1, 200), 7);
  assert.equal(clampInt(-3, 50, 1, 200), 1);
  assert.equal(clampInt(999, 50, 1, 200), 200);
});

test('assertScope: eigenes Kapitel/Abschnitt null, fremdes → Fehler-Key', async () => {
  assert.equal(await assertScope(ctx(), { chapterId: chSub, pageId: P_SUB }), null);
  assert.equal((await assertScope(ctx(), { chapterId: chForeign })).errorKey, 'chat.toolError.chapterNotInBook');
  assert.equal((await assertScope(ctx(), { pageId: P_FOREIGN })).errorKey, 'chat.toolError.pageNotInBook');
  assert.equal((await assertScope(ctx(), { chapterId: 99999999 })).errorKey, 'chat.toolError.chapterNotInBook');
});

// ── Teilbaum ─────────────────────────────────────────────────────────────────

test('list_ideen: chapter_id umfasst Unterkapitel', async () => {
  const iSub = ideenDb.createIdee({ bookId: BOOK, pageId: P_SUB, userEmail: USER, content: 'im Unterkapitel' });
  const r = await run('list_ideen', { chapter_id: chTop });
  assert.ok(r.ideen.some(i => i.id === iSub), JSON.stringify(r));
});

test('get_reviews: stale über den Teilbaum des Kapitels', async () => {
  // Bewertung von «Teil Eins» liegt zwischen NOW (eigener Abschnitt) und LATER
  // (Abschnitt im Unterkapitel) — die Bewertung umfasst das Unterkapitel.
  db.prepare('INSERT INTO chapter_reviews (book_id, chapter_id, reviewed_at, review_json, user_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, chTop, '2026-02-01T00:00:00.000Z', JSON.stringify({ gesamtnote: 4, fazit: 'ok' }), USER);
  const r = await run('get_reviews', { scope: 'chapter' });
  const rev = r.reviews.find(x => x.chapter_id === chTop);
  assert.equal(rev?.stale, true, JSON.stringify(r));
});

// ── Scope ────────────────────────────────────────────────────────────────────

test('fremde chapter_id/page_id → NotInBook statt leerer Liste', async () => {
  const cases = [
    ['list_ideen', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_ideen', { page_id: P_FOREIGN }, 'pageNotInBook'],
    ['list_scenes', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_scenes', { page_id: P_FOREIGN }, 'pageNotInBook'],
    ['list_locations', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_songs', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['get_lektorat', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['get_lektorat', { page_id: P_FOREIGN }, 'pageNotInBook'],
    ['get_stil_metrics', { scope: 'chapter', chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_continuity_issues', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['get_edit_status', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_redundancies', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['find_repetitions', { scope: 'chapter', chapter_id: chForeign }, 'chapterNotInBook'],
    ['find_repetitions', { scope: 'page', page_id: P_FOREIGN }, 'pageNotInBook'],
    ['list_research_items', { chapter_id: chForeign }, 'chapterNotInBook'],
    ['list_research_items', { page_id: P_FOREIGN }, 'pageNotInBook'],
  ];
  for (const [name, input, key] of cases) {
    const r = await run(name, input);
    assert.equal(r.errorKey, `chat.toolError.${key}`, `${name} ${JSON.stringify(input)} → ${JSON.stringify(r).slice(0, 200)}`);
  }
  // Eigenes Kapitel bleibt ohne Fehler.
  assert.equal((await run('list_scenes', { chapter_id: chSub })).errorKey, undefined);
});

// ── Namens-Lookups in Handlern ───────────────────────────────────────────────

const insLoc = db.prepare('INSERT INTO locations (book_id, loc_id, name, user_email, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
insLoc.run(BOOK, 'loc_1', 'Österreich-Haus', USER, NOW, 1);
insLoc.run(BOOK, 'loc_2', 'Wassermühle', USER, NOW, 2);
insLoc.run(BOOK, 'loc_3', 'Wasserturm', USER, NOW, 3);

test('get_location_profile: Umlaut gross/klein, Mehrdeutigkeit', async () => {
  assert.equal((await run('get_location_profile', { name: 'österreich' })).loc_id, 'loc_1');
  const amb = await run('get_location_profile', { name: 'wasser' });
  assert.equal(amb.errorKey, 'chat.toolError.ambiguousName');
  assert.deepEqual(amb.candidates.map(c => c.loc_id).sort(), ['loc_2', 'loc_3']);
  assert.equal((await run('get_location_profile', { name: 'turm' })).loc_id, 'loc_3');
});

test('get_motifs: mehrdeutiger Name → ambiguousName', async () => {
  const insMotif = db.prepare('INSERT INTO motifs (book_id, user_email, name, position) VALUES (?, ?, ?, ?)');
  insMotif.run(BOOK, USER, 'Spiegelbild', 1);
  insMotif.run(BOOK, USER, 'Spiegelscherben', 2);
  insMotif.run(BOOK, USER, 'Ärger', 3);
  const amb = await run('get_motifs', { motif_name: 'spiegel' });
  assert.equal(amb.errorKey, 'chat.toolError.ambiguousName', JSON.stringify(amb));
  assert.equal((await run('get_motifs', { motif_name: 'ÄRGER' })).name, 'Ärger');
});

// ── Parameter ────────────────────────────────────────────────────────────────

const figId = db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run(BOOK, 'fig_1', 'Anna', USER, NOW).lastInsertRowid;

test('list_figures: limit:"viele" → Default statt leerer Liste', async () => {
  const r = await run('list_figures', { limit: 'viele' });
  assert.equal(r.results.length, 1);
});

// ── Erwähnungssumme ──────────────────────────────────────────────────────────

test('list_figures: mentions nur aus Abschnitten desselben Buchs', async () => {
  const ins = db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count) VALUES (?, ?, ?)');
  ins.run(P_TOP, figId, 3);
  ins.run(P_FOREIGN, figId, 5);
  const r = await run('list_figures', {});
  assert.equal(r.results[0].mentions, 3);
});

// ── FTS-Fehler ───────────────────────────────────────────────────────────────

test('list_research_items: FTS-Fehler → search_failed vorn, nicht ungefiltert', async () => {
  researchItems.createItem({ bookId: BOOK, userEmail: USER, kind: 'note', title: 'Eintrag A', body: 'x' });
  const orig = searchIndex.query;
  searchIndex.query = () => { throw new Error('fts kaputt'); };
  try {
    const r = await run('list_research_items', { q: 'irgendwas' });
    assert.equal(r.search_failed, true, JSON.stringify(r));
    assert.equal(Object.keys(r)[0], 'search_failed');
    assert.ok(r.hint);
    assert.equal((r.items || []).length, 0);
  } finally {
    searchIndex.query = orig;
  }
});

// ── Zusammenfassungen vor Listen ─────────────────────────────────────────────

const keyIdx = (o, k) => Object.keys(o).indexOf(k);

test('get_plot_board: total_*/Legenden vor acts', async () => {
  const act = plot.createAct(BOOK, USER, { name: 'Akt 1' });
  plot.createBeat(BOOK, act.id, USER, { titel: 'Start' });
  const r = await run('get_plot_board', {});
  assert.ok(keyIdx(r, 'total_beats') < keyIdx(r, 'acts'), Object.keys(r).join(','));
  assert.ok(keyIdx(r, 'status_legende') < keyIdx(r, 'acts'), Object.keys(r).join(','));
});

test('get_motifs (Übersicht): total_*/Legende vor themes/motifs', async () => {
  const r = await run('get_motifs', {});
  assert.ok(keyIdx(r, 'total_motifs') < keyIdx(r, 'themes'), Object.keys(r).join(','));
  assert.ok(keyIdx(r, 'soll_ist_legende') < keyIdx(r, 'motifs'), Object.keys(r).join(','));
});

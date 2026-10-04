'use strict';
// Integration test: 6 neue Book-Chat-Tools
// get_book_settings / find_repetitions / get_dialogue / diff_page_revisions /
// find_first_last_mention / quote_passage (DB-only Pfade).

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookChatTools;
let pageRevisions;

test.before(() => {
  ctx = bootstrap();
  bookChatTools = require('../../routes/jobs/book-chat-tools');
  pageRevisions = require('../../db/page-revisions');
});
test.after(() => { ctx.cleanup(); });

// ── get_book_settings ────────────────────────────────────────────────────────

test('get_book_settings: liefert Defaults für leeres Buch', () => {
  const BOOK_ID = 8001;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Mein Buch');

  const result = bookChatTools.TOOLS.get_book_settings({}, {
    bookId: BOOK_ID, userEmail: 'alice@example.com',
  });
  assert.equal(result.book_id, BOOK_ID);
  assert.equal(result.book_name, 'Mein Buch');
  assert.equal(result.language, 'de');
  assert.equal(result.region, 'CH');
  assert.equal(result.locale, 'de-CH');
  assert.equal(result.is_finished, 0);
});

test('get_book_settings: löst Buchtyp/POV/Tempus zu Labels auf', () => {
  const BOOK_ID = 8002;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Krimi');
  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'DE', 'krimi', 'Düster, knapp.', 'ich', 'praeteritum', 1, 0, 5000);

  const result = bookChatTools.TOOLS.get_book_settings({}, {
    bookId: BOOK_ID, userEmail: 'alice@example.com',
  });
  assert.equal(result.buchtyp, 'krimi');
  assert.equal(result.buchtyp_label, 'Krimi / Thriller');
  assert.equal(result.erzaehlperspektive, 'ich');
  assert.match(result.erzaehlperspektive_label, /1\. Person/);
  assert.equal(result.erzaehlzeit, 'praeteritum');
  assert.match(result.erzaehlzeit_label, /Präteritum/);
  assert.equal(result.buch_kontext, 'Düster, knapp.');
  assert.equal(result.is_finished, 1);
  assert.equal(result.daily_goal_chars, 5000);
});

// ── find_repetitions ────────────────────────────────────────────────────────

test('find_repetitions: findet wiederkehrendes Tri-Gramm', () => {
  const BOOK_ID = 8010;
  const body = '<p>' + Array(8).fill('Sie ging zur Tür').join(' und dann ') + '</p>';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Wdh' }],
    chapters: [{ id: 80100, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 80101, book_id: BOOK_ID, name: 'P1', chapter_id: 80100 }],
    pageBodies: { 80101: body },
  });

  const result = bookChatTools.TOOLS.find_repetitions(
    { n: 3, scope: 'book', min_count: 5 },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.pages_scanned, 1);
  const hit = result.results.find(r => r.phrase === 'sie ging zur');
  assert.ok(hit, `expected "sie ging zur" in ${JSON.stringify(result.results.slice(0, 5))}`);
  assert.ok(hit.count >= 5);
  assert.equal(hit.sample_pages[0].page_id, 80101);
});

test('find_repetitions: scope=page bricht ohne page_id', () => {
  const result = bookChatTools.TOOLS.find_repetitions(
    { scope: 'page' },
    { bookId: 8010, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /page_id/);
});

// ── get_dialogue ────────────────────────────────────────────────────────────

test('get_dialogue: extrahiert Anführungszeichen-Dialoge', () => {
  const BOOK_ID = 8020;
  // DE-typografische Anführungszeichen — vermeidet das «...»-Inversion-Merge,
  // bei dem zwei CH-Guillemet-Dialoge mit der inverted-DE-Pattern »…«
  // verschmolzen werden.
  const body = '<p>„Hallo&#8220;, sagte Anna. „Geht’s?&#8220; fragte sie.</p>';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Dlg' }],
    chapters: [{ id: 80200, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 80201, book_id: BOOK_ID, name: 'P1', chapter_id: 80200 }],
    pageBodies: { 80201: body },
  });

  const result = bookChatTools.TOOLS.get_dialogue(
    {},
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.ok(result.results.length >= 2, `expected >=2 dialogues, got ${result.results.length}`);
  assert.ok(result.results.some(r => r.text.includes('Hallo')));
  for (const r of result.results) {
    assert.equal(typeof r.offset, 'number');
    assert.equal(typeof r.length, 'number');
  }
});

// ── diff_page_revisions ─────────────────────────────────────────────────────

test('diff_page_revisions: vergleicht zwei jüngste Revisionen', () => {
  const BOOK_ID = 8030;
  const PAGE_ID = 80301;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Rev' }],
    chapters: [{ id: 80300, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, name: 'P1', chapter_id: 80300 }],
    pageBodies: { [PAGE_ID]: '<p>alter Text</p>' },
  });

  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>Sie ging zur alten Tür.</p>',
    source: 'main', userEmail: 'alice@example.com',
  });
  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>Sie rannte zur neuen Tür.</p>',
    source: 'main', userEmail: 'alice@example.com',
  });

  const result = bookChatTools.TOOLS.diff_page_revisions(
    { page_id: PAGE_ID },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.page_id, PAGE_ID);
  assert.notEqual(result.unchanged, true);
  assert.ok(result.from && result.to);
  assert.ok(result.blocks.length > 0);
  const changes = result.blocks.filter(b => b.kind === 'change' || b.kind === 'add' || b.kind === 'del');
  assert.ok(changes.length > 0);
});

test('diff_page_revisions: < 2 Revisionen → Fehler', () => {
  const BOOK_ID = 8031;
  const PAGE_ID = 80311;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'OneRev' }],
    chapters: [{ id: 80310, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, name: 'P1', chapter_id: 80310 }],
    pageBodies: { [PAGE_ID]: '<p>foo</p>' },
  });
  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>nur eine Revision</p>',
    source: 'main', userEmail: 'alice@example.com',
  });

  const result = bookChatTools.TOOLS.diff_page_revisions(
    { page_id: PAGE_ID },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /< 2|Weniger/);
});

// ── find_first_last_mention ─────────────────────────────────────────────────

test('find_first_last_mention: liefert Fehler ohne Argument', () => {
  const result = bookChatTools.TOOLS.find_first_last_mention(
    {},
    { bookId: 8001, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /figur|loc_id/i);
});

test('find_first_last_mention: figur ohne Index → freundlicher Fehler', () => {
  const BOOK_ID = 8040;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'FL' }],
    chapters: [],
    pages: [],
  });
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
    VALUES (?, ?, 'fig_1', 'Anna', 'Anna', ?)
  `).run(BOOK_ID, 'alice@example.com', new Date().toISOString());

  const result = bookChatTools.TOOLS.find_first_last_mention(
    { figur_id: 'fig_1' },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.fig_id, 'fig_1');
  assert.match(result.error, /Index|Erwähnung/);
});

// ── list_songs ──────────────────────────────────────────────────────────────

test('list_songs: liefert Soundtrack mit Kapitel-/Figur-Verknüpfung + filtert', () => {
  const BOOK_ID = 8050;
  const CH1 = 80500, CH2 = 80501;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Mixtape' }],
    chapters: [{ id: CH1, book_id: BOOK_ID, name: 'K1' }, { id: CH2, book_id: BOOK_ID, name: 'K2' }],
    pages: [],
  });
  const { db } = require('../../db/connection');
  const now = new Date().toISOString();

  const fig = db.prepare(`
    INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
    VALUES (?, ?, 'fig_h', 'Held', 'Held', ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  const figId = fig.lastInsertRowid;

  const s1 = db.prepare(`
    INSERT INTO songs (book_id, song_uid, titel, interpret, genre, stimmung, user_email, sort_order, updated_at)
    VALUES (?, 'song_a', 'Heldenlied', 'Band X', 'Rock', 'episch', ?, 0, ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  const s1Id = s1.lastInsertRowid;
  db.prepare(`
    INSERT INTO songs (book_id, song_uid, titel, user_email, sort_order, updated_at)
    VALUES (?, 'song_b', 'Outro', ?, 1, ?)
  `).run(BOOK_ID, 'alice@example.com', now);

  db.prepare('INSERT INTO song_chapters (song_id, chapter_id, haeufigkeit) VALUES (?, ?, 3)').run(s1Id, CH1);
  db.prepare('INSERT INTO song_figures (song_id, figure_id, kontext_typ) VALUES (?, ?, ?)').run(s1Id, figId, 'leitmotiv');

  const all = bookChatTools.TOOLS.list_songs({}, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(all.total, 2);
  const lied = all.songs.find(s => s.song_id === 'song_a');
  assert.equal(lied.titel, 'Heldenlied');
  assert.equal(lied.interpret, 'Band X');
  assert.equal(lied.kapitel[0].chapter_id, CH1);
  assert.equal(lied.kapitel[0].haeufigkeit, 3);
  assert.equal(lied.figuren[0].fig_id, 'fig_h');
  assert.equal(lied.szenen, undefined);

  const byChapter = bookChatTools.TOOLS.list_songs({ chapter_id: CH1 }, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(byChapter.total, 1);
  assert.equal(byChapter.songs[0].song_id, 'song_a');

  const byFig = bookChatTools.TOOLS.list_songs({ figur_name: 'Held' }, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(byFig.total, 1);
  assert.equal(byFig.songs[0].song_id, 'song_a');
});

test('list_songs: leeres Resultat liefert hint', () => {
  const BOOK_ID = 8051;
  ctx.dbSeed.setBook({ books: [{ id: BOOK_ID, name: 'Stumm' }], chapters: [], pages: [] });
  const result = bookChatTools.TOOLS.list_songs({}, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(result.total, 0);
  assert.match(result.hint, /Songs/);
});

// ── get_location_profile ────────────────────────────────────────────────────

test('get_location_profile: tiefes Profil per loc_id + Name-Fallback', () => {
  const BOOK_ID = 8060;
  const CH1 = 80600;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Welt' }],
    chapters: [{ id: CH1, book_id: BOOK_ID, name: 'K1' }],
    pages: [],
  });
  const { db } = require('../../db/connection');
  const now = new Date().toISOString();

  const loc = db.prepare(`
    INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, stimmung, user_email, sort_order, updated_at)
    VALUES (?, 'loc_wald', 'Dunkler Wald', 'natur', 'Dicht und nass.', 'bedrohlich', ?, 0, ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  const locId = loc.lastInsertRowid;

  const figJ = db.prepare(`
    INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
    VALUES (?, ?, 'fig_j', 'Jäger', 'Jäger', ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  const scene = db.prepare(`
    INSERT INTO figure_scenes (book_id, user_email, titel, wertung, chapter_id, updated_at)
    VALUES (?, ?, 'Verfolgung', 'spannend', ?, ?)
  `).run(BOOK_ID, 'alice@example.com', CH1, now);

  db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, 2)').run(locId, CH1);
  db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)').run(locId, figJ.lastInsertRowid);
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(scene.lastInsertRowid, locId);

  const byId = bookChatTools.TOOLS.get_location_profile({ loc_id: 'loc_wald' }, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(byId.name, 'Dunkler Wald');
  assert.equal(byId.typ, 'natur');
  assert.equal(byId.stimmung, 'bedrohlich');
  assert.equal(byId.total_kapitel, 1);
  assert.equal(byId.kapitel[0].chapter_id, CH1);
  assert.equal(byId.last_chapter.chapter_id, CH1);
  assert.equal(byId.figuren[0].fig_id, 'fig_j');
  assert.equal(byId.total_szenen, 1);
  assert.equal(byId.szenen[0].titel, 'Verfolgung');
  assert.equal(byId.szenen[0].chapter_id, CH1);

  const byName = bookChatTools.TOOLS.get_location_profile({ name: 'dunkler' }, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(byName.loc_id, 'loc_wald');
});

test('list_locations: Orte mit assoziierten Figuren (figure_id-Join)', () => {
  const BOOK_ID = 8061;
  ctx.dbSeed.setBook({ books: [{ id: BOOK_ID, name: 'Karte' }], chapters: [], pages: [] });
  const { db } = require('../../db/connection');
  const now = new Date().toISOString();
  const loc = db.prepare(`
    INSERT INTO locations (book_id, loc_id, name, user_email, sort_order, updated_at)
    VALUES (?, 'loc_burg', 'Burg', ?, 0, ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  const fig = db.prepare(`
    INSERT INTO figures (book_id, user_email, fig_id, name, updated_at)
    VALUES (?, ?, 'fig_k', 'König', ?)
  `).run(BOOK_ID, 'alice@example.com', now);
  db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)')
    .run(loc.lastInsertRowid, fig.lastInsertRowid);

  const result = bookChatTools.TOOLS.list_locations({}, { bookId: BOOK_ID, userEmail: 'alice@example.com' });
  assert.equal(result.total, 1);
  assert.equal(result.locations[0].figuren[0].fig_id, 'fig_k');
  assert.equal(result.locations[0].figuren[0].name, 'König');
});

test('get_location_profile: unbekannter Ort → Fehler', () => {
  const result = bookChatTools.TOOLS.get_location_profile(
    { loc_id: 'nope' },
    { bookId: 8060, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /nicht gefunden/);
});

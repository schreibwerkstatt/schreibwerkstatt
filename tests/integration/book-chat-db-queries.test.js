'use strict';
// Integration: die Seiten-/Kapitel-/Buch-Abfragen der Buch-Chat-Tools liegen in
// db/book-chat/*.js. Die Tests treiben die Tools über ein gemeinsames Buch und
// prüfen die Stellen, an denen das SQL Semantik trägt: Leserichtung
// (chapters.position/pages.position), Kapitel nur aus demselben Buch
// (`c.book_id = p.book_id`), optionale Filter, jüngster Check/Review je Einheit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let TOOLS;
let db;

const BOOK = 9101;
const OTHER = 9102;
const U = 'alice@example.com';
const T = '2026-01-01T10:00:00.000Z';
const T2 = '2026-02-01T10:00:00.000Z';
const call = (name, input = {}) => TOOLS[name](input, { bookId: BOOK, userEmail: U, inputBudgetChars: 100000 });

const ids = {};

// Zweiter User und Aufrufer im Buch OTHER (Abschnitt „Abgeleitete Tabellen").
const V = 'bob@example.com';
const callO = (name, input = {}, user = U) => TOOLS[name](input, { bookId: OTHER, userEmail: user, inputBudgetChars: 100000 });
const o = {};

function seed() {
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Queries' }, { id: OTHER, name: 'Fremd' }],
    // Kapitel-ID-Reihenfolge absichtlich gegen die Leserichtung.
    chapters: [
      { id: 91011, book_id: BOOK, name: 'Zwei', position: 2 },
      { id: 91012, book_id: BOOK, name: 'Eins', position: 1 },
      { id: 91021, book_id: OTHER, name: 'FremdKap', position: 1 },
    ],
    pages: [
      { id: 910101, book_id: BOOK, name: 'P-Zwei', chapter_id: 91011, position: 1, updated_at: T2 },
      { id: 910102, book_id: BOOK, name: 'P-Eins-b', chapter_id: 91012, position: 2, updated_at: T },
      { id: 910103, book_id: BOOK, name: 'P-Eins-a', chapter_id: 91012, position: 1, updated_at: T },
      { id: 910104, book_id: BOOK, name: 'P-ohne', position: 0, updated_at: T },
    ],
    pageBodies: {
      910101: '<p>„Hallo Anna“, sagte Bert. Anna ging zur Tür.</p>',
      910102: '<p>Bert rief: „Komm her!“ Anna ging zur Tür und wieder zur Tür.</p>',
      910103: '<p>Kurz.</p>',
      910104: '<p>Ohne Kapitel. Anna im Wald.</p>',
    },
  });
  // Seite im eigenen Buch, deren Kapitel in einem fremden Buch liegt — der
  // Seeder verwirft unbekannte Kapitel, darum direkt.
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (910105, ?, 'P-fremdkap', 91021, 3, ?, '<p>Bert schwieg.</p>')`).run(BOOK, T);

  const insPs = db.prepare(`INSERT INTO page_stats (page_id, book_id, words, chars, sentences, dialog_chars, pronoun_counts, passive_count, avg_sentence_len)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insPs.run(910101, BOOK, 10, 50, 2, 12, JSON.stringify({ ich: { narr: 1, dlg: 2 } }), 3, 5);
  insPs.run(910102, BOOK, 12, 60, 2, 10, JSON.stringify({ ich: { narr: 4, dlg: 0 } }), 1, 6);
  insPs.run(910103, BOOK, 1, 5, 1, 0, null, 0, 1);
  insPs.run(910104, BOOK, 5, 25, 2, 0, JSON.stringify({ wir: { narr: 1, dlg: 0 } }), 2, 2.5);

  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ids.anna = insFig.run(BOOK, U, 'fig_anna', 'Anna Adler', 'Anna', 1, T).lastInsertRowid;
  ids.bert = insFig.run(BOOK, U, 'fig_bert', 'Bert Berg', 'Bert', 0, T).lastInsertRowid;
  const insPfm = db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)');
  insPfm.run(910101, ids.anna, 2, 8);
  insPfm.run(910102, ids.anna, 1, 25);
  insPfm.run(910104, ids.anna, 1, 14);
  insPfm.run(910102, ids.bert, 1, 0);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(ids.anna, 91011, 2);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(ids.anna, 91012, 1);
  db.prepare(`INSERT INTO figure_events (figure_id, datum, ereignis, chapter_id, page_id, sort_order) VALUES (?, '2000', 'Geburt', 91012, 910103, 0)`).run(ids.anna);

  const insSc = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, page_id, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ids.sceneA = insSc.run(BOOK, U, 'Tür-Szene', 91011, 910101, 1, T).lastInsertRowid;
  ids.sceneB = insSc.run(BOOK, U, 'Ruf-Szene', 91012, 910102, 0, T).lastInsertRowid;
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(ids.sceneA, ids.anna);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(ids.sceneB, ids.bert);

  const insIdee = db.prepare('INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insIdee.run(BOOK, 910102, null, U, 'an Seite', 'offen', T, T);
  insIdee.run(BOOK, null, 91012, U, 'am Kapitel', 'erledigt', T, T2);

  const insPc = db.prepare('INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, fazit, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const errs = (typ, n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ typ, original: `o${i}`, korrektur: `k${i}` })));
  insPc.run(910101, BOOK, T, 9, errs('stil', 9), 'alt', U);
  insPc.run(910101, BOOK, T2, 1, errs('stil', 1), 'neu', U);
  insPc.run(910102, BOOK, T, 3, errs('grammatik', 3), null, U);
  insPc.run(910103, BOOK, T, 2, errs('stil', 2), null, U);

  const review = note => JSON.stringify({ gesamtnote: note, fazit: 'f', staerken: [], schwaechen: [] });
  const insCr = db.prepare('INSERT INTO chapter_reviews (book_id, chapter_id, reviewed_at, review_json, user_email) VALUES (?, ?, ?, ?, ?)');
  insCr.run(BOOK, 91011, '2025-12-01T00:00:00.000Z', review(2), U);
  insCr.run(BOOK, 91011, '2026-01-15T00:00:00.000Z', review(5), U);
  db.prepare('INSERT INTO book_reviews (book_id, reviewed_at, review_json, user_email) VALUES (?, ?, ?, ?)')
    .run(BOOK, '2026-01-15T00:00:00.000Z', review(4), U);

  const check = db.prepare('INSERT INTO continuity_checks (book_id, checked_at, summary, user_email) VALUES (?, ?, ?, ?)').run(BOOK, T, 's', U).lastInsertRowid;
  const issue = db.prepare(`INSERT INTO continuity_issues (check_id, book_id, user_email, schwere, typ, sort_order) VALUES (?, ?, ?, 'hoch', 'zeit', 0)`).run(check, BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, 0)').run(issue, 91012);

  const evt = db.prepare(`INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis, sort_order) VALUES (?, ?, '2000', 'E1', 0)`).run(BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, 0)').run(evt, 91011);
  db.prepare('INSERT INTO zeitstrahl_event_pages (event_id, page_id, sort_order) VALUES (?, ?, 0)').run(evt, 910104);

  const fact = db.prepare(`INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email) VALUES (?, 'magie', 'Anna', 'fliegt', 0, ?)`).run(BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(fact, 91011);
  db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(fact, 91012);
}

test.before(() => {
  ctx = bootstrap();
  TOOLS = require('../../routes/jobs/book-chat-tools').TOOLS;
  db = require('../../db/connection').db;
  seed();
  seedOther();
});
test.after(() => { ctx.cleanup(); });

// ── Katalog ─────────────────────────────────────────────────────────────────

test('list_chapters: Kapitel und Seiten in Leserichtung, Seite ohne Kapitel separat', () => {
  const r = call('list_chapters');
  assert.deepEqual(r.chapters.map(c => c.chapter_name), ['Eins', 'Zwei']);
  // Seiten kompakt als Tupel [page_id, page_name, words] (page_format).
  assert.equal(r.page_format, '[page_id, page_name, words]');
  assert.deepEqual(r.chapters[0].pages.map(p => p[1]), ['P-Eins-a', 'P-Eins-b']);
  assert.equal(r.chapters[0].words, 13);
  assert.deepEqual(r.pages_without_chapter.map(p => p[1]), ['P-ohne']);
  assert.equal(r.total_pages, 5);
  // Zusammenfassung steht VOR der Kapitelliste (überlebt jeden Schnitt).
  const keys = Object.keys(r);
  assert.ok(keys.indexOf('total_words') < keys.indexOf('chapters'));
});

test('list_chapters: Paginierung über offset/limit mit next_offset', () => {
  const r1 = call('list_chapters', { limit: 1 });
  assert.deepEqual(r1.chapters.map(c => c.chapter_name), ['Eins']);
  assert.equal(r1.next_offset, 1);
  assert.equal(r1.total_chapters, 2);
  const r2 = call('list_chapters', { offset: 1, limit: 1 });
  assert.deepEqual(r2.chapters.map(c => c.chapter_name), ['Zwei']);
  assert.equal(r2.next_offset, undefined);
  assert.equal(r2.pages_without_chapter, undefined);
});

test('list_ideen: Kapitelname über Seite oder Kapitel, Kapitel-Filter deckt beide Anker', () => {
  const r = call('list_ideen', { chapter_id: 91012 });
  assert.equal(r.total, 2);
  assert.deepEqual(r.ideen.map(i => [i.scope, i.chapter_name]), [['page', 'Eins'], ['chapter', 'Eins']]);
  assert.equal(call('list_ideen', { offen_only: true }).total, 1);
});

test('list_scenes: Kapitel-/Seitenname per JOIN, Figurenfilter', () => {
  const all = call('list_scenes');
  assert.deepEqual(all.scenes.map(s => [s.titel, s.chapter_name, s.page_name]),
    [['Ruf-Szene', 'Eins', 'P-Eins-b'], ['Tür-Szene', 'Zwei', 'P-Zwei']]);
  const anna = call('list_scenes', { figur_id: 'fig_anna' });
  assert.deepEqual(anna.scenes.map(s => s.titel), ['Tür-Szene']);
});

test('list_figures: Erwähnungssumme aus page_figure_mentions', () => {
  const r = call('list_figures');
  assert.deepEqual(r.results.map(f => [f.fig_id, f.mentions]), [['fig_anna', 4], ['fig_bert', 1]]);
});

test('list_revisions: chapter_id aus der Seite, chapter_name nur aus demselben Buch', () => {
  const r = call('list_revisions', { page_id: 910105 });
  assert.equal(r.chapter_id, 91021);
  assert.equal(r.chapter_name, null);
  assert.match(call('list_revisions', { page_id: 999999 }).error, /nicht im aktuellen Buch/);
});

test('list_world_facts: Kapitelnamen je Fakt in Leserichtung', () => {
  assert.deepEqual(call('list_world_facts').fakten[0].kapitel, ['Eins', 'Zwei']);
});

// ── Figuren ─────────────────────────────────────────────────────────────────

test('count_pronouns per_chapter: Seiten ohne Kapitel unter „(ohne Kapitel)"', () => {
  const r = call('count_pronouns', { per_chapter: true, pronouns: ['ich', 'wir'] });
  const byName = Object.fromEntries(r.chapters.map(c => [c.chapter_name, c.counts]));
  assert.deepEqual(byName.Zwei.ich, { narr: 1, dlg: 2 });
  assert.deepEqual(byName.Eins.ich, { narr: 4, dlg: 0 });
  assert.deepEqual(byName['(ohne Kapitel)'].wir, { narr: 1, dlg: 0 });
});

test('get_figure_mentions + find_first_last_mention: erste/letzte Seite in Leserichtung', () => {
  const m = call('get_figure_mentions', { figur_id: 'fig_anna' });
  assert.equal(m.total_mentions, 4);
  // ohne Kapitel (position NULL) zuerst, dann Eins vor Zwei
  assert.equal(m.first_appearance.page_name, 'P-ohne');
  assert.equal(m.last_appearance.page_name, 'P-Zwei');
  const f = call('find_first_last_mention', { figur_id: 'fig_anna' });
  assert.equal(f.first_appearance.first_offset, 14);
  assert.equal(f.last_appearance.chapter_name, 'Zwei');
});

test('get_figure_profile: Kapitel, Ereignisse, Szenen mit Namen', () => {
  const p = call('get_figure_profile', { figur_id: 'fig_anna' });
  assert.deepEqual(p.kapitel.map(k => k.chapter_name), ['Eins', 'Zwei']);
  assert.equal(p.lebensereignisse[0].page_name, 'P-Eins-a');
  assert.equal(p.szenen[0].chapter_name, 'Zwei');
});

// ── Analyse ─────────────────────────────────────────────────────────────────

test('get_reviews: jüngste Kapitelbewertung, stale gegen pages.updated_at, fehlende Kapitel', () => {
  const r = call('get_reviews');
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].gesamtnote, 5);
  assert.equal(r.reviews[0].stale, true);
  assert.deepEqual(r.ohne_bewertung.map(c => c.chapter_name), ['Eins']);
  const book = call('get_reviews', { scope: 'book' });
  assert.equal(book.book_name, 'Queries');
  assert.equal(book.stale, true);
});

test('get_lektorat_hotspots / findings: nur jüngster Check je Seite, Filter', () => {
  const h = call('get_lektorat_hotspots');
  assert.equal(h.total_errors, 6);
  assert.deepEqual(h.top_pages.map(p => p.page_name), ['P-Eins-b', 'P-Eins-a', 'P-Zwei']);
  assert.equal(call('get_lektorat_hotspots', { chapter_id: 91011 }).pages_checked, 1);
  const f = call('get_lektorat_findings', { chapter_id: 91012 });
  assert.deepEqual([...new Set(f.findings.map(x => x.page_name))], ['P-Eins-a', 'P-Eins-b']);
  assert.equal(call('get_lektorat_findings', { page_id: 910101 }).total_findings, 1);
});

test('get_stil_metrics: Kapitel-Aggregat in Leserichtung, Seiten-Ranking, Top-Figuren', () => {
  const ch = call('get_stil_metrics', { scope: 'chapter', include_figures: true });
  assert.deepEqual(ch.chapters.map(c => c.chapter_name), ['(ohne Kapitel)', 'Eins', 'Zwei']);
  assert.deepEqual(ch.chapters.find(c => c.chapter_name === 'Eins').top_figuren.map(f => f.fig_id), ['fig_anna', 'fig_bert']);
  const pg = call('get_stil_metrics', { scope: 'page', metric: 'avg_sentence_len', order: 'asc', limit: 2 });
  assert.deepEqual(pg.pages.map(p => p.page_name), ['P-Eins-a', 'P-ohne']);
});

test('listPageStilMetric lehnt eine Spalte ausserhalb STIL_METRIC_COLS ab', () => {
  const { listPageStilMetric } = require('../../db/book-chat/analysis');
  assert.throws(() => listPageStilMetric(BOOK, 'words; DROP TABLE pages', 'DESC', 5), /Unbekannte Stil-Metrik/);
});

// ── Text ────────────────────────────────────────────────────────────────────

test('get_chapter_text: Seiten eines Kapitels in Leserichtung, fremdes Kapitel abgewiesen', async () => {
  const r = await call('get_chapter_text', { chapter_id: 91012 });
  assert.deepEqual(r.pages.map(p => p.page_name), ['P-Eins-a', 'P-Eins-b']);
  assert.match((await call('get_chapter_text', { chapter_id: 91021 })).error, /nicht im aktuellen Buch/);
});

test('get_pages / quote_match: Kapitelname nur aus demselben Buch', async () => {
  const pages = await call('get_pages', { ids: [910101, 910105] });
  assert.deepEqual(pages.pages.map(p => [p.page_name, p.chapter_name]), [['P-Zwei', 'Zwei'], ['P-fremdkap', null]]);
  const q = await call('quote_match', { page_id: 910102, pattern: 'tür', occurrence: 2 });
  assert.equal(q.chapter_name, 'Eins');
  assert.equal(q.total_matches, 2);
});

test('search_passages (Regex) + get_dialogue: Scope-Filter auf Kapitel', async () => {
  const s = await call('search_passages', { pattern: 'Tür', regex: true, chapter_id: 91012 });
  assert.ok(s.results.length >= 2);
  assert.ok(s.results.every(x => x.chapter_id === 91012));
  const d = call('get_dialogue', { chapter_id: 91011 });
  assert.ok(d.results.length >= 1);
  assert.ok(d.results.every(x => x.page_id === 910101));
});

// ── Zeitstrahl / Kontinuität ────────────────────────────────────────────────

test('list_continuity_issues + get_timeline: Kapitel-/Seitennamen der Bridges', () => {
  const c = call('list_continuity_issues', { chapter_id: 91012 });
  assert.equal(c.total, 1);
  assert.equal(c.issues[0].kapitel[0].chapter_name, 'Eins');
  const t = call('get_timeline');
  assert.equal(t.events[0].kapitel[0].chapter_name, 'Zwei');
  assert.equal(t.events[0].seiten[0].page_name, 'P-ohne');
});

// ── Abgeleitete Tabellen (figures, locations, songs, …) ─────────────────────
// Eigenes Buch OTHER, damit die Zählungen der Tests oben unberührt bleiben.

function seedOther() {
  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, typ, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  o.nord = insFig.run(OTHER, U, 'fig_nord', 'Anna Nord', 'Anna', 'haupt', 0, T).lastInsertRowid;
  o.ann = insFig.run(OTHER, U, 'fig_ann', 'Ann', null, 'neben', 1, T).lastInsertRowid;
  o.zoe = insFig.run(OTHER, U, 'fig_zoe', 'Zoe', null, null, 2, T).lastInsertRowid;
  o.bobAnn = insFig.run(OTHER, V, 'fig_ann', 'Ann Bob', null, null, 0, T).lastInsertRowid;
  db.prepare('INSERT INTO figure_tags (figure_id, tag) VALUES (?, ?)').run(o.nord, 'mutig');

  const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insRel.run(OTHER, o.zoe, o.ann, 'feind', null, U, null, null);
  insRel.run(OTHER, o.nord, o.ann, 'freund', 'd', U, 1, JSON.stringify(['b1', 'b2', 'b3', 'b4']));
  insRel.run(OTHER, o.bobAnn, o.nord, 'fremd', null, V, null, null);

  const insLoc = db.prepare('INSERT INTO locations (book_id, loc_id, name, sort_order, user_email, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  o.hafen = insLoc.run(OTHER, 'loc_hafen', 'Hafen', 0, U, T).lastInsertRowid;
  o.hafenBook = insLoc.run(BOOK, 'loc_hafen', 'Hafen im Nachbarbuch', 0, U, T).lastInsertRowid;
  const insLf = db.prepare('INSERT INTO location_figures (location_id, figure_id) VALUES (?, ?)');
  insLf.run(o.hafen, o.nord);
  insLf.run(o.hafen, o.bobAnn); // fremder User — darf nicht erscheinen
  const insLc = db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, 2)');
  insLc.run(o.hafen, 91021);
  insLc.run(o.hafenBook, 91011);

  const insSc = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)');
  o.scene = insSc.run(OTHER, U, 'Hafen-Szene', 0, T).lastInsertRowid;
  insSc.run(OTHER, U, 'Leere Szene', 1, T);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(o.scene, o.nord);
  db.prepare('INSERT INTO scene_locations (scene_id, location_id) VALUES (?, ?)').run(o.scene, o.hafen);

  const insSong = db.prepare('INSERT INTO songs (book_id, song_uid, titel, sort_order, user_email, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  o.song = insSong.run(OTHER, 'song_x', 'Seemannslied', 0, U, T).lastInsertRowid;
  db.prepare('INSERT INTO song_figures (song_id, figure_id, kontext_typ) VALUES (?, ?, ?)').run(o.song, o.nord, 'singt');
  db.prepare('INSERT INTO song_scenes (scene_id, song_id) VALUES (?, ?)').run(o.scene, o.song);

  const insCc = db.prepare('INSERT INTO continuity_checks (book_id, checked_at, summary, user_email) VALUES (?, ?, ?, ?)');
  const oldCheck = insCc.run(OTHER, T, 'alt', U).lastInsertRowid;
  const check = insCc.run(OTHER, T2, 'neu', U).lastInsertRowid;
  insCc.run(OTHER, '2026-03-01T10:00:00.000Z', 'bob', V);
  const insCi = db.prepare('INSERT INTO continuity_issues (check_id, book_id, user_email, schwere, typ, beschreibung, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insCi.run(oldCheck, OTHER, U, 'hoch', 'zeit', 'aus altem Check', 0);
  const i2 = insCi.run(check, OTHER, U, 'niedrig', 'ort', 'zweites', 1).lastInsertRowid;
  const i1 = insCi.run(check, OTHER, U, 'hoch', 'figur', 'erstes', 0).lastInsertRowid;
  const insCif = db.prepare('INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
  insCif.run(i1, o.nord, 'ignoriert', 1);
  insCif.run(i1, null, 'Freitext', 0);
  insCif.run(i2, null, null, 0); // ohne Namen — fällt weg

  const insZe = db.prepare('INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis, typ, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const e2 = insZe.run(OTHER, U, '2001', 'Später', null, 1).lastInsertRowid;
  const e1 = insZe.run(OTHER, U, '2000', 'Früher', 'politisch', 0).lastInsertRowid;
  insZe.run(OTHER, V, '1990', 'Bob', null, 0);
  const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures (event_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
  insZef.run(e1, o.nord, null, 1);
  insZef.run(e1, null, 'Frei', 0);
  insZef.run(e2, o.ann, null, 0);

  const insWf = db.prepare('INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email) VALUES (?, ?, ?, ?, ?, ?)');
  insWf.run(OTHER, 'magie', 'Anna Nord', 'zaubert', 1, U);
  insWf.run(OTHER, 'geografie', 'Hafen', 'liegt im Norden', 0, U);
  insWf.run(OTHER, 'magie', 'Zoe', 'kann nichts', 2, U);
  insWf.run(OTHER, 'magie', 'Anna Nord', 'bob', 0, V);
}

test('_findFigure: fig_id exakt je User, Name mit Exact-Match-Bonus', () => {
  assert.equal(callO('get_figure_profile', { figur_id: 'fig_ann' }).name, 'Ann');
  assert.equal(callO('get_figure_profile', { figur_id: 'fig_ann' }, V).name, 'Ann Bob');
  // „Ann" trifft „Anna Nord" (LIKE) und „Ann" (exakt) — exakt gewinnt trotz höherer id.
  assert.equal(callO('get_figure_profile', { figur_name: 'Ann' }).fig_id, 'fig_ann');
  // „Anna" ist exakt der kurzname von Anna Nord.
  assert.equal(callO('get_figure_profile', { figur_name: 'Anna' }).fig_id, 'fig_nord');
  assert.equal(callO('get_figure_profile', { figur_id: 'fig_nord' }, V).error, 'Figur nicht gefunden');
});

test('get_figure_relations / get_figure_profile: Kanten nach Namen, User-Scope, belege gekappt', () => {
  const r = callO('get_figure_relations');
  assert.deepEqual(r.edges.map(e => [e.from.name, e.to.name]), [['Anna Nord', 'Ann'], ['Zoe', 'Ann']]);
  assert.deepEqual(r.edges[0].belege, ['b1', 'b2', 'b3']);
  assert.deepEqual(r.nodes.map(n => n.fig_id).sort(), ['fig_ann', 'fig_nord', 'fig_zoe']);
  assert.equal(callO('get_figure_relations', { figur_id: 'fig_zoe' }).total, 1);
  const p = callO('get_figure_profile', { figur_id: 'fig_nord' });
  assert.deepEqual(p.eigenschaften, ['mutig']);
  assert.deepEqual(p.beziehungen.map(b => b.to.name), ['Ann']);
  assert.equal(p.typ, 'haupt');
});

test('list_locations / get_location_profile: Figuren nur aus Buch + User', () => {
  const l = callO('list_locations');
  assert.deepEqual(l.locations.map(x => [x.loc_id, x.figuren.map(f => f.fig_id)]), [['loc_hafen', ['fig_nord']]]);
  const p = callO('get_location_profile', { loc_id: 'loc_hafen' });
  assert.equal(p.name, 'Hafen');
  assert.deepEqual(p.figuren.map(f => f.fig_id), ['fig_nord']);
  assert.match(callO('get_location_profile', { loc_id: 'loc_hafen' }, V).error, /^Ort nicht gefunden/);
});

test('list_scenes / list_songs: Figuren-, Orts- und Szenen-Bridges, loc_id-Filter im Buch', () => {
  const s = callO('list_scenes', { loc_id: 'loc_hafen' });
  assert.deepEqual(s.scenes.map(x => x.titel), ['Hafen-Szene']);
  assert.deepEqual(s.scenes[0].figuren, [{ fig_id: 'fig_nord', name: 'Anna Nord' }]);
  assert.deepEqual(s.scenes[0].orte, [{ loc_id: 'loc_hafen', name: 'Hafen' }]);
  assert.equal(callO('list_scenes', { loc_id: 'loc_nope' }).error, 'Ort nicht gefunden');
  const g = callO('list_songs');
  assert.deepEqual(g.songs[0].figuren, [{ fig_id: 'fig_nord', name: 'Anna Nord', kontext_typ: 'singt' }]);
  assert.deepEqual(g.songs[0].szenen, [{ scene_id: o.scene, titel: 'Hafen-Szene' }]);
});

test('find_first_last_mention (Ort): loc_id getrimmt, Buch- und User-Scope', () => {
  const r = callO('find_first_last_mention', { loc_id: ' loc_hafen ' });
  assert.equal(r.name, 'Hafen');
  assert.equal(call('find_first_last_mention', { loc_id: 'loc_hafen' }).name, 'Hafen im Nachbarbuch');
  assert.match(callO('find_first_last_mention', { loc_id: 'loc_hafen' }, V).error, /^Ort nicht gefunden/);
});

test('list_continuity_issues: nur jüngster Check des Users, Figuren mit Freitext-Fallback', () => {
  const c = callO('list_continuity_issues');
  assert.equal(c.summary, 'neu');
  assert.deepEqual(c.issues.map(i => i.beschreibung), ['erstes', 'zweites']);
  assert.deepEqual(c.issues[0].figuren, [{ fig_id: null, name: 'Freitext' }, { fig_id: 'fig_nord', name: 'Anna Nord' }]);
  assert.deepEqual(c.issues[1].figuren, []);
  assert.equal(callO('list_continuity_issues', {}, V).summary, 'bob');
});

test('get_timeline: sort_order, Figuren-Fallback, Fokusfigur, User-Scope', () => {
  const t = callO('get_timeline');
  assert.deepEqual(t.events.map(e => e.ereignis), ['Früher', 'Später']);
  assert.deepEqual(t.events[0].figuren, [{ fig_id: null, name: 'Frei' }, { fig_id: 'fig_nord', name: 'Anna Nord' }]);
  assert.deepEqual(callO('get_timeline', { figur_id: 'fig_ann' }).events.map(e => e.ereignis), ['Später']);
  assert.deepEqual(callO('get_timeline', {}, V).events.map(e => e.ereignis), ['Bob']);
});

test('list_world_facts: sort_order, kategorie exakt, subjekt als Teilstring, User-Scope', () => {
  assert.deepEqual(callO('list_world_facts').fakten.map(f => f.fakt), ['liegt im Norden', 'zaubert', 'kann nichts']);
  assert.deepEqual(callO('list_world_facts', { kategorie: 'MAGIE' }).fakten.map(f => f.fakt), ['zaubert', 'kann nichts']);
  assert.deepEqual(callO('list_world_facts', { subjekt: 'Nor' }).fakten.map(f => f.fakt), ['zaubert']);
  assert.deepEqual(callO('list_world_facts', {}, V).fakten.map(f => f.fakt), ['bob']);
});

test('get_stil_metrics (Buch) / count_pronouns (Buch): Summen nur über das eigene Buch', () => {
  const s = call('get_stil_metrics', { scope: 'book' });
  assert.equal(s.pages, 4);
  assert.equal(s.passive_count, 6);
  assert.equal(s.words, 28);
  assert.ok(callO('get_stil_metrics', { scope: 'book' }).hint);
  const p = call('count_pronouns', { pronouns: ['ich'] });
  assert.equal(p.pages_indexed, 3);
  assert.deepEqual(p.counts.ich, { narr: 5, dlg: 2 });
});

test('get_pages: latest_check ist der jüngste Check des Users', async () => {
  const mine = await call('get_pages', { ids: [910101] });
  assert.equal(mine.pages[0].latest_check.fazit, 'neu');
  const other = await TOOLS.get_pages({ ids: [910101] }, { bookId: BOOK, userEmail: V, inputBudgetChars: 100000 });
  assert.equal(other.pages[0].latest_check, undefined);
});

test('resolveEntityTitle: Szene/Figur per id, gelöscht → null', () => {
  const { resolveEntityTitle } = require('../../routes/jobs/book-chat-tools/shared');
  assert.equal(resolveEntityTitle('scene', o.scene), 'Hafen-Szene');
  assert.equal(resolveEntityTitle('figure', o.zoe), 'Zoe');
  assert.equal(resolveEntityTitle('figure', 99999999), null);
  assert.equal(resolveEntityTitle('page', 910101), 'P-Zwei');
});

test('list_research_items: Kapitel-Filter deckt Kapitel- und Seiten-Verknüpfung, Status-Filter, Stellen mit Namen', () => {
  const ins = db.prepare("INSERT INTO research_items (book_id, user_email, kind, title, status) VALUES (?, ?, 'fact', ?, ?)");
  const atChapter = ins.run(BOOK, U, 'Am Kapitel', 'offen').lastInsertRowid;
  const atPage = ins.run(BOOK, U, 'An Seite', 'eingearbeitet').lastInsertRowid;
  const loose = ins.run(BOOK, U, 'Lose', 'offen').lastInsertRowid;
  ins.run(OTHER, U, 'Fremdes Buch', 'offen');
  db.prepare("INSERT INTO research_item_links (item_id, target_kind, chapter_id) VALUES (?, 'chapter', 91012)").run(atChapter);
  db.prepare("INSERT INTO research_item_links (item_id, target_kind, page_id) VALUES (?, 'page', 910103)").run(atPage);

  const all = call('list_research_items');
  assert.deepEqual(all.items.map(i => i.id).sort(), [atChapter, atPage, loose].sort());

  const kap = call('list_research_items', { chapter_id: 91012 });
  assert.deepEqual(kap.items.map(i => i.id).sort(), [atChapter, atPage].sort());
  assert.deepEqual(call('list_research_items', { page_id: 910103 }).items.map(i => i.id), [atPage]);
  assert.deepEqual(call('list_research_items', { status: 'eingearbeitet' }).items.map(i => i.id), [atPage]);

  const p = kap.items.find(i => i.id === atPage);
  assert.deepEqual(p.stellen, [{ art: 'page', id: 910103, name: 'P-Eins-a' }]);
  assert.equal(p.status, 'eingearbeitet');

  const read = call('read_research_item', { id: atChapter });
  assert.deepEqual(read.stellen, [{ art: 'chapter', id: 91012, name: 'Eins' }]);
  assert.equal(call('read_research_item', { id: 999999 }).error.length > 0, true);
});

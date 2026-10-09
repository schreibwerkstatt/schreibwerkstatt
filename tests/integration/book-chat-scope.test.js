'use strict';
// Integration: Buch-/User-Scope der Buch-Chat-Werkzeuge und das Alters-Werkzeug.
//   - get_pages liefert Seiten eines FREMDEN Buchs nicht aus (missing, ohne Inhalt).
//   - search_similar/Erst-Kontext: Szenen/Figuren eines anderen Users fallen weg
//     (resolveEntityTitle mit userEmail).
//   - get_figure_age rechnet deterministisch aus Steckbrief/Geburts-Ereignis/Zeitstrahl.
//   - Zitat-Fussnoten (_buildCitations): Seitenname nur für Seiten im eigenen Buch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let TOOLS;
let db;

const BOOK = 9301;
const FOREIGN = 9302;
const U = 'alice@example.com';
const V = 'bob@example.com';
const T = '2026-01-01T10:00:00.000Z';
const call = (name, input = {}, user = U) => TOOLS[name](input, { bookId: BOOK, userEmail: user, inputBudgetChars: 100000 });
const ids = {};

function seed() {
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Eigen' }, { id: FOREIGN, name: 'Fremd' }],
    chapters: [
      { id: 93011, book_id: BOOK, name: 'K1', position: 1 },
      { id: 93021, book_id: FOREIGN, name: 'FK1', position: 1 },
    ],
    pages: [
      { id: 930101, book_id: BOOK, name: 'Eigene Seite', chapter_id: 93011, position: 1, updated_at: T },
      { id: 930201, book_id: FOREIGN, name: 'Geheime Seite', chapter_id: 93021, position: 1, updated_at: T },
    ],
    pageBodies: {
      930101: '<p>Anna kam 1961 zur Welt.</p>',
      930201: '<p>STRENG GEHEIMER FREMDTEXT</p>',
    },
  });

  db.prepare('INSERT OR REPLACE INTO book_settings (book_id, zeitlinie_real, updated_at) VALUES (?, 1, ?)').run(BOOK, T);
  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, geburtstag, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ids.anna  = insFig.run(BOOK, U, 'fig_anna', 'Anna Adler', 'Anna', '12. März 1961', 0, T).lastInsertRowid;
  ids.bert  = insFig.run(BOOK, U, 'fig_bert', 'Bert Berg', 'Bert', null, 1, T).lastInsertRowid;
  ids.cleo  = insFig.run(BOOK, U, 'fig_cleo', 'Cleo Cron', 'Cleo', null, 2, T).lastInsertRowid;
  ids.fremd = insFig.run(BOOK, V, 'fig_fremd', 'Fremdfigur', null, null, 0, T).lastInsertRowid;

  // Zeitstrahl des Users: Geburt Bert (nur Jahr), Mauerfall mit Tag.
  const insZe = db.prepare(`INSERT INTO zeitstrahl_events (book_id, user_email, datum, datum_year, datum_month, datum_day, datum_unsicher, ereignis, subtyp, sort_order)
                            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  const bertBirth = insZe.run(BOOK, U, '1970', 1970, null, null, 'Bert wird geboren', 'geburt', 0).lastInsertRowid;
  insZe.run(BOOK, U, '9. November 1989', 1989, 11, 9, 'Mauerfall in Berlin', null, 1);
  insZe.run(BOOK, U, '1. Februar 1989', 1989, 2, 1, 'Anna zieht um', null, 2);
  db.prepare('INSERT INTO zeitstrahl_event_figures (event_id, figure_id, sort_order) VALUES (?, ?, 0)').run(bertBirth, ids.bert);

  const insSc = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, page_id, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ids.sceneU = insSc.run(BOOK, U, 'Eigene Szene', 93011, 930101, 0, T).lastInsertRowid;
  ids.sceneV = insSc.run(BOOK, V, 'Fremde Szene', 93011, 930101, 1, T).lastInsertRowid;
}

test.before(() => {
  ctx = bootstrap();
  TOOLS = require('../../routes/jobs/book-chat-tools').TOOLS;
  db = require('../../db/connection').db;
  seed();
});

test('get_pages: Seite eines fremden Buchs → missing, kein Inhalt', async () => {
  const r = await call('get_pages', { ids: [930101, 930201, 99999999] });
  assert.deepEqual(r.pages.map(p => p.page_id), [930101]);
  assert.deepEqual(r.missing.map(m => m.page_id), [930201, 99999999]);
  assert.ok(!JSON.stringify(r).includes('GEHEIM'), 'Fremdtext darf nicht im Ergebnis stehen');
});

test('übrige Seiten-/Kapitel-Werkzeuge weisen fremde IDs ab', async () => {
  assert.match((await call('quote_passage', { page_id: 930201, offset: 0, length: 5 })).error, /nicht im aktuellen Buch/);
  assert.match((await call('quote_match', { page_id: 930201, pattern: 'GEHEIM' })).error, /nicht im aktuellen Buch/);
  assert.match((await call('get_chapter_text', { chapter_id: 93021 })).error, /nicht im aktuellen Buch/);
  assert.match(call('list_revisions', { page_id: 930201 }).error, /nicht im aktuellen Buch/);
  assert.match(call('diff_page_revisions', { page_id: 930201 }).error, /nicht im aktuellen Buch/);
  const dlg = call('get_dialogue', { page_id: 930201 });
  assert.deepEqual(dlg.results, []);
  const rep = call('find_repetitions', { scope: 'page', page_id: 930201 });
  assert.ok(!JSON.stringify(rep).includes('GEHEIM'));
});

test('resolveEntityTitle: mit userEmail fallen Szenen/Figuren anderer User weg', () => {
  const { resolveEntityTitle } = require('../../routes/jobs/book-chat-tools/shared');
  assert.equal(resolveEntityTitle('scene', ids.sceneU, { userEmail: U }), 'Eigene Szene');
  assert.equal(resolveEntityTitle('scene', ids.sceneV, { userEmail: U }), null);
  assert.equal(resolveEntityTitle('figure', ids.fremd, { userEmail: U }), null);
  assert.equal(resolveEntityTitle('figure', ids.fremd, { userEmail: V }), 'Fremdfigur');
  // Ohne Scope-Angabe: unverändert (Altverhalten für Aufrufer ohne User).
  assert.equal(resolveEntityTitle('scene', ids.sceneV), 'Fremde Szene');
});

test('get_figure_age: exakt mit Monat/Tag aus dem Steckbrief, zu Jahr und Ereignis', () => {
  const r = call('get_figure_age', { figur_name: 'Anna', ereignis: 'Mauerfall', jahr: 2000 });
  assert.deepEqual(r.geburt, { jahr: 1961, monat: 3, tag: 12, quelle: 'steckbrief' });
  assert.equal(r.zeitlinie_real, true);
  assert.equal(r.zum_jahr.jahr, 2000);
  assert.deepEqual([r.zum_jahr.alter_von, r.zum_jahr.alter_bis], [38, 39]); // nur Jahr → Spanne
  assert.equal(r.zu_ereignissen.length, 1);
  assert.equal(r.zu_ereignissen[0].alter, 28);   // 9.11.1989, Geburtstag im März vorbei
  assert.equal(r.zu_ereignissen[0].exakt, true);
  const r2 = call('get_figure_age', { figur_name: 'Anna', ereignis: 'zieht um' });
  assert.equal(r2.zu_ereignissen[0].alter, 27);  // 1.2.1989, Geburtstag noch nicht
});

test('get_figure_age: Geburtsjahr aus dem Geburts-Ereignis → Spanne, ohne Geburtsjahr → Hinweis', () => {
  const r = call('get_figure_age', { figur_id: 'fig_bert', jahr: 1989 });
  assert.equal(r.geburt.quelle, 'geburts_ereignis');
  assert.deepEqual([r.zum_jahr.alter_von, r.zum_jahr.alter_bis], [18, 19]);
  const c = call('get_figure_age', { figur_name: 'Cleo', jahr: 1989 });
  assert.equal(c.geburt, null);
  assert.match(c.zum_jahr.hinweis, /Kein Geburtsjahr/);
  assert.match(c.hinweis, /Kein Geburtsjahr/);
  // Figur eines anderen Users ist für U nicht sichtbar.
  assert.match(call('get_figure_age', { figur_id: 'fig_fremd' }).error, /nicht gefunden/);
  const none = call('get_figure_age', { figur_name: 'Anna', ereignis: 'Mondlandung' });
  assert.deepEqual(none.zu_ereignissen, []);
  assert.match(none.ereignis_hinweis, /Kein datiertes Ereignis/);
});

test('ageAt: Spanne ohne Monat, exakt mit Monat, vor der Geburt markiert', () => {
  const { ageAt } = require('../../routes/jobs/book-chat-tools/tools-timeline');
  assert.deepEqual(ageAt({ y: 1960 }, { y: 1990 }), { alter_von: 29, alter_bis: 30, exakt: false });
  assert.deepEqual(ageAt({ y: 1960, m: 5 }, { y: 1990, m: 6 }), { alter: 30, exakt: true });
  assert.deepEqual(ageAt({ y: 1960, m: 5, d: 20 }, { y: 1990, m: 5, d: 19 }), { alter: 29, exakt: true });
  assert.equal(ageAt({ y: 1990 }, { y: 1980 }).vor_geburt, true);
  assert.equal(ageAt({ y: null }, { y: 1980 }), null);
});

test('Zitat-Fussnoten: Seitenname nur im eigenen Buch, ungültige markiert', () => {
  const { _buildCitations } = require('../../routes/jobs/chat/book-chat-agent');
  const out = _buildCitations(
    [
      { page_id: 930101, offset: 0, length: 4, quote: 'Anna' },
      { page_id: 930201, offset: 0, length: 6, quote: 'STRENG' },
      { page_id: 930101, offset: 0, length: 4, quote: 'Otto' },
    ],
    [
      { page_id: 930101, valid: true },
      { page_id: 930201, valid: false, reason: 'page_not_in_book' },
      { page_id: 930101, valid: false, reason: 'quote_mismatch', expected: 'Otto', actual: 'Anna' },
    ],
  );
  assert.deepEqual(out[0], { n: 1, page_id: 930101, page_name: 'Eigene Seite', quote: 'Anna', valid: true });
  assert.equal(out[1].page_id, null);
  assert.equal(out[1].page_name, null);
  assert.equal(out[1].reason, 'page_not_in_book');
  assert.equal(out[2].valid, false);
  assert.equal(out[2].reason, 'quote_mismatch');
});

test('_retrievalQuery: Folgefrage trägt die letzte Runde mit', () => {
  const { _retrievalQuery } = require('../../routes/jobs/chat/book-chat-agent');
  const q = _retrievalQuery('und wie alt war sie da?', [
    { role: 'user', content: 'Wann zog Anna nach Berlin?' },
    { role: 'assistant', content: '1989, im Februar.' },
  ]);
  assert.match(q, /Anna nach Berlin/);
  assert.match(q, /1989/);
  assert.ok(q.endsWith('und wie alt war sie da?'));
  assert.equal(_retrievalQuery('nur Frage', []), 'nur Frage');
});

test('getFiguren: Geburtsjahr nach derselben Vorrangregel wie get_figure_age, Widerspruch ausgewiesen', () => {
  const { getFiguren } = require('../../routes/jobs/shared/queries');
  // Alters-Index: Bert widerspricht seinem Geburts-Ereignis (1970), Dora hat nur den Index.
  const T2 = '2026-01-02T10:00:00.000Z';
  ids.dora = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, 'fig_dora', 'Dora Dorn', 3, ?)`).run(BOOK, U, T2).lastInsertRowid;
  const insAge = db.prepare('INSERT INTO figure_ages (figure_id, book_id, geburtsjahr) VALUES (?, ?, ?)');
  insAge.run(ids.bert, BOOK, 1971);
  insAge.run(ids.dora, BOOK, 1980);

  const byId = Object.fromEntries(getFiguren(BOOK, U).map(f => [f.id, f]));
  assert.equal(byId.fig_anna.geburtstag, '12. März 1961');
  assert.equal(byId.fig_anna.geburtsjahr, 1961);
  assert.equal(byId.fig_anna.geburtsjahr_quelle, 'steckbrief');
  assert.equal(byId.fig_anna.geburtsjahr_widerspruch, undefined);
  assert.equal(byId.fig_bert.geburtsjahr, 1970);
  assert.equal(byId.fig_bert.geburtsjahr_quelle, 'geburts_ereignis');
  assert.deepEqual(byId.fig_bert.geburtsjahr_widerspruch,
    [{ quelle: 'geburts_ereignis', jahr: 1970 }, { quelle: 'alters_index', jahr: 1971 }]);
  assert.equal(byId.fig_dora.geburtsjahr, 1980);
  assert.equal(byId.fig_dora.geburtsjahr_quelle, 'alters_index');
  assert.equal(byId.fig_cleo.geburtsjahr, undefined);
  assert.equal(byId.fig_fremd, undefined);
  // Werkzeug und Block sagen dasselbe.
  assert.deepEqual(call('get_figure_age', { figur_id: 'fig_bert' }).geburtsjahr_widerspruch, byId.fig_bert.geburtsjahr_widerspruch);
});

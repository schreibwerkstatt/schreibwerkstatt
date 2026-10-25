'use strict';
// Sicht eines Werkzeug-Aufrufs im Verlauf der agentischen Chats
// (routes/jobs/agentic-chat/tool-view.js): IDs werden beim Speichern zu Namen —
// nur im eigenen Buch und nur bei erfolgreichem Aufruf —, technische Argumente
// fallen weg, das Ergebnis wird zur Mengenangabe.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('chat-tool-view');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const { makeToolViewer } = require('../../routes/jobs/agentic-chat/tool-view');

const USER = 'view@example.com';
const BOOK = 82001;
const OTHER = 82002;
const NOW = '2026-01-01T00:00:00.000Z';
appUsers.createUser({ email: USER });
for (const [id, name] of [[BOOK, 'Sicht'], [OTHER, 'Fremd']]) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, NOW, NOW);
}
db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)').run(8201, BOOK, 'Erster Teil', 0, NOW);
db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?,?,?)').run(82011, BOOK, 'Ankunft');
db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?,?,?)').run(82021, OTHER, 'Geheim');
db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)').run(BOOK, 'fig_1', 'Stefan Berger', USER, NOW);
const actId = db.prepare('INSERT INTO plot_acts (book_id, user_email, name, position) VALUES (?, ?, ?, 0)').run(BOOK, USER, 'Aufbruch').lastInsertRowid;

const describe = makeToolViewer({ bookId: BOOK, userEmail: USER });

test('IDs werden zu Namen, technische Argumente fallen weg', () => {
  const v = describe('search_passages', { pattern: 'März 2000', chapter_id: 8201, max_results: 15, regex: true }, { results: [1, 2] }, true);
  assert.deepEqual(v.subject, [
    { t: 'q', v: 'März 2000' },
    { t: 'ref', k: 'chapter', id: '8201', v: 'Erster Teil' },
  ]);
  assert.deepEqual(v.result, { key: 'chat.toolResult.hits', params: { n: 2 } });
});

test('Figur, Akt und Abschnitt; fremder Abschnitt bleibt nackte ID', () => {
  assert.deepEqual(describe('get_timeline', { figur_id: 'fig_1', limit: 60 }, { events: [] }, true).subject,
    [{ t: 'ref', k: 'figure', id: 'fig_1', v: 'Stefan Berger' }]);
  assert.deepEqual(describe('get_plot_board', { act_id: actId }, { acts: [{}] }, true).subject,
    [{ t: 'ref', k: 'act', id: String(actId), v: 'Aufbruch' }]);
  const pages = describe('get_pages', { ids: [82011, 82021] }, { pages: [{}, {}] }, true);
  assert.deepEqual(pages.subject, [
    { t: 'ref', k: 'page', id: '82011', v: 'Ankunft' },
    { t: 'ref', k: 'page', id: '82021' },
  ]);
  assert.deepEqual(pages.result, { key: 'chat.toolResult.sections', params: { n: 2 } });
});

test('Fehlgeschlagener Aufruf: keine Namensauflösung, kein Ergebnis', () => {
  const v = describe('get_figure_profile', { figur_id: 'fig_1' }, { error: 'Figur nicht gefunden' }, false);
  assert.deepEqual(v.subject, [{ t: 'ref', k: 'figure', id: 'fig_1' }]);
  assert.equal(v.result, null);
});

test('Ergebnisse: Nulltreffer, Zitat-Check, Vorschlag, lange Liste mit Rest', () => {
  assert.deepEqual(describe('search_passages', { pattern: 'x' }, { results: [] }, true).result, { key: 'chat.toolResult.hitsNone' });
  assert.deepEqual(describe('quote_match', { page_id: 82011, pattern: 'Tür' }, { total_matches: 3 }, true).result,
    { key: 'chat.toolResult.quoteFoundOf', params: { n: 3 } });
  assert.deepEqual(describe('propose_beat', { titel: 'Neujahr', act_id: actId, begruendung: 'lang …' }, { ok: true }, true), {
    subject: [{ t: 'q', v: 'Neujahr' }, { t: 'ref', k: 'act', id: String(actId), v: 'Aufbruch' }],
    result: { key: 'chat.toolResult.proposed' },
  });
  const many = describe('get_pages', { ids: [1, 2, 3, 4, 5] }, { pages: [] }, true).subject;
  assert.deepEqual(many.at(-1), { t: 'more', v: 2 });
  assert.equal(describe('list_ideen', { offen_only: true, limit: 30 }, { ideen: [] }, true).subject[0].k, 'offen_only');
});

test('neue Katalogformate: quote_passage mit pattern, get_motifs mit Motiv, Kennzahlen ohne Menge; Kürzung', () => {
  assert.deepEqual(describe('quote_passage', { page_id: 82011, pattern: 'Tür' }, { total_matches: 2 }, true).result,
    { key: 'chat.toolResult.quoteFoundOf', params: { n: 2 } });
  assert.deepEqual(describe('quote_passage', { page_id: 82011, offset: 10, length: 5 }, { quote: 'abcde' }, true).result,
    { key: 'chat.toolResult.quoted', params: { n: 5 } });
  assert.deepEqual(describe('get_motifs', { motif_name: 'Haus' }, { ist_count: 7, occurrences: [1, 2] }, true).result,
    { key: 'chat.toolResult.hits', params: { n: 7 } });
  assert.equal(describe('get_stil_metrics', { pronouns: ['alle'] }, { pronouns: ['ich', 'du'] }, true).result, null);
  assert.deepEqual(describe('get_lektorat', { view: 'hotspots' }, { hotspots: [1] }, true).subject, [{ t: 'f', k: 'view', v: 'hotspots' }]);
  assert.deepEqual(describe('list_chapters', {}, { total_chapters: 120, chapters: new Array(30).fill(0) }, true).trunc, { shown: 30, total: 120 });
  assert.equal(describe('list_chapters', {}, { total_chapters: 11, chapters: new Array(11).fill(0) }, true).trunc, undefined);
});

test('Lauf-Protokoll: Rundennotiz, Live-Kopie ohne Rohargumente', () => {
  const { roundNote, liveTools } = require('../../routes/jobs/agentic-chat/tool-view');
  assert.equal(roundNote('  Ich prüfe\n die Zitate. '), 'Ich prüfe die Zitate.');
  assert.equal(roundNote('{"antwort":"x"}'), null, 'JSON ist keine Notiz');
  assert.equal(roundNote('x'.repeat(400)).length, 280);
  const live = liveTools([{ name: 'search_passages', input: { pattern: 'geheim' }, ok: true, iter: 1, durationMs: 2, truncated: false, view: { subject: [], result: null }, skipped: true }]);
  assert.deepEqual(live, [{ name: 'search_passages', ok: true, iter: 1, durationMs: 2, truncated: false, view: { subject: [], result: null }, skipped: true }]);
});

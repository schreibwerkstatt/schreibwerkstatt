'use strict';
// Auto-Erledigt-Check der Ideen (routes/jobs/ideen-auto-check.js, db/ideen-check.js)
// und Zusammenführen (db/ideen.js#mergeIdeen) gegen eine Wegwerf-DB, KI gemockt:
//  - Mass «grössere Änderung» (Wort-Multimenge)
//  - Auslöser: ohne Ausgangsstand nur Ausgangsstand, kleine Änderung nichts,
//    grosse Änderung startet den Job; Schalter aus → nichts
//  - Job: nur wörtlich belegte, offene Abschnitts-Pendenzen werden Hinweis;
//    erfundenes Zitat, fremde/geschlossene Idee fallen heraus; Ausgangsstand rückt nach
//  - Hinweis in der Ausgabeform (check_hint), Stufenwechsel räumt ihn ab
//  - Zusammenführen: Links wandern, Quellen fallen, abgeschlossenes Ziel lehnt offene Quelle ab

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('ideen-auto-check');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
const ai = require('../../lib/ai');

// callAI vor dem ersten Laden von routes/jobs/shared ersetzen (dort destrukturiert).
const calls = [];
let nextAnswer = { eingeloest: [] };
ai.callAI = async (prompt, system) => {
  calls.push({ prompt: String(prompt), system: String(system) });
  return { text: JSON.stringify(nextAnswer), tokensIn: 100, tokensOut: 20, truncated: false, model: 'mock' };
};

const ideenDb = require('../../db/ideen');
const ideenCheck = require('../../db/ideen-check');
const { createJob, jobs } = require('../../routes/jobs/shared');
const {
  changedWordCount, runIdeenAutoCheckJob, _afterQuiet, MIN_CHANGED_WORDS,
} = require('../../routes/jobs/ideen-auto-check');

const USER = 'autocheck@example.com';
const OTHER = 'autocheck-other@example.com';
const BOOK = 83301;
const NOW = '2026-01-01T00:00:00.000Z';
appUsers.createUser({ email: USER });
appUsers.createUser({ email: OTHER });
appSettings.set('ai.provider', 'claude');
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Prüfbuch', ?, ?)`).run(BOOK, NOW, NOW);
const PAGE = 8330101;
const TEXT = '<p>Am Abend schliesst Lea die Tür zum Keller ab und versteckt den Schlüssel unter dem Stein.</p>';
db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Der Keller', ?, ?)`).run(PAGE, BOOK, TEXT, NOW);

const mk = (content, extra = {}) => ideenDb.createIdee({ bookId: BOOK, pageId: PAGE, userEmail: USER, content, ...extra });
const hintOf = (id) => ideenDb.getIdee(id).check_hint;

test('changedWordCount: zählt hinzugekommene und weggefallene Wörter, Gross/Klein egal', () => {
  assert.equal(changedWordCount('a b c', 'A B C'), 0);
  assert.equal(changedWordCount('a b c', 'a b d'), 2);
  assert.equal(changedWordCount('', 'eins zwei drei'), 3);
  assert.equal(changedWordCount('x x x', 'x'), 2);
});

test('Job: nur wörtlich belegte offene Abschnitts-Pendenzen werden Hinweis', async () => {
  const tuer = mk('Lea soll die Kellertür abschliessen');
  const brief = mk('Brief der Mutter einbauen');
  const zu = mk('Schon erledigt');
  ideenDb.updateIdee(zu, USER, { status: 'erledigt' });
  const fremd = ideenDb.createIdee({ bookId: BOOK, pageId: PAGE, userEmail: OTHER, content: 'fremde Pendenz' });
  nextAnswer = { eingeloest: [
    { idee_id: tuer, beleg: 'schliesst Lea die Tür zum Keller ab', begruendung: 'steht da' },
    { idee_id: brief, beleg: 'Lea liest den Brief der Mutter', begruendung: 'erfunden' },
    { idee_id: zu, beleg: 'schliesst Lea die Tür zum Keller ab', begruendung: 'geschlossen' },
    { idee_id: fremd, beleg: 'schliesst Lea die Tür zum Keller ab', begruendung: 'fremd' },
  ] };
  calls.length = 0;
  const jobId = createJob('ideen-auto-check', BOOK, USER, 'x');
  await runIdeenAutoCheckJob(jobId, PAGE, BOOK, USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.equal(j.result.hints, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Kellertür/);
  assert.ok(!calls[0].prompt.includes('Schon erledigt'), 'geschlossene Idee nicht im Prompt');
  assert.ok(!calls[0].prompt.includes('fremde Pendenz'), 'fremde Idee nicht im Prompt');
  assert.equal(hintOf(tuer).beleg, 'schliesst Lea die Tür zum Keller ab');
  assert.equal(hintOf(tuer).page_id, PAGE);
  assert.equal(hintOf(tuer).page_name, 'Der Keller');
  assert.equal(hintOf(brief), null);
  assert.equal(hintOf(fremd), null);
  assert.match(ideenCheck.getBaseline(PAGE, USER), /Schlüssel unter dem Stein/);

  // Stufenwechsel beantwortet den Hinweis; clearHint wirkt nur für den Besitzer.
  const other = mk('Schlüssel verstecken');
  ideenCheck.setHint(other, USER, { pageId: PAGE, beleg: 'versteckt den Schlüssel' });
  assert.equal(ideenCheck.clearHint(other, OTHER), 0);
  assert.ok(hintOf(other));
  ideenDb.updateIdee(tuer, USER, { status: 'erledigt' });
  assert.equal(hintOf(tuer), null);
  assert.equal(ideenCheck.clearHint(other, USER), 1);
  assert.equal(hintOf(other), null);
});

test('Job: Antwort ohne eingeloest-Feld → Fehler, Ausgangsstand bleibt', async () => {
  ideenCheck.setBaseline(PAGE, USER, 'alt');
  nextAnswer = { falsch: true };
  const jobId = createJob('ideen-auto-check', BOOK, USER, 'x');
  await runIdeenAutoCheckJob(jobId, PAGE, BOOK, USER);
  assert.equal(jobs.get(jobId).status, 'error');
  assert.equal(ideenCheck.getBaseline(PAGE, USER), 'alt');
});

test('Auslöser: Ausgangsstand zuerst, dann nur grosse Änderung, Schalter aus → nichts', async () => {
  const PAGE2 = 8330102;
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Zwei', '<p>eins zwei drei</p>', ?)`).run(PAGE2, BOOK, NOW);
  ideenDb.createIdee({ bookId: BOOK, pageId: PAGE2, userEmail: USER, content: 'offen' });
  const count = () => [...jobs.values()].filter(j => j.type === 'ideen-auto-check').length;
  const before = count();
  const active = () => (count() > before ? 'lauf' : null);

  await _afterQuiet(PAGE2, BOOK, USER);
  assert.equal(ideenCheck.getBaseline(PAGE2, USER), 'eins zwei drei');
  assert.equal(active(), null, 'ohne Ausgangsstand kein Lauf');

  db.prepare('UPDATE pages SET body_html = ? WHERE page_id = ?').run('<p>eins zwei drei vier</p>', PAGE2);
  await _afterQuiet(PAGE2, BOOK, USER);
  assert.equal(active(), null, 'kleine Änderung startet nichts');

  const many = Array.from({ length: MIN_CHANGED_WORDS + 5 }, (_, i) => `wort${i}`).join(' ');
  db.prepare('UPDATE pages SET body_html = ? WHERE page_id = ?').run(`<p>${many}</p>`, PAGE2);
  ideenCheck.setAutoCheck(USER, false);
  await _afterQuiet(PAGE2, BOOK, USER);
  assert.equal(active(), null, 'Schalter aus');
  ideenCheck.setAutoCheck(USER, true);
  nextAnswer = { eingeloest: [] };
  await _afterQuiet(PAGE2, BOOK, USER);
  assert.equal(count(), before + 1, 'grosse Änderung startet genau einen Job');
});

test('mergeIdeen: Links wandern, Quellen fallen, abgeschlossenes Ziel nimmt keine offene Quelle', () => {
  db.prepare("INSERT INTO research_items (id, book_id, user_email, kind, title) VALUES (8330, ?, ?, 'note', 'Fund')").run(BOOK, USER);
  db.prepare("INSERT INTO research_items (id, book_id, user_email, kind, title) VALUES (8331, ?, ?, 'note', 'Fund 2')").run(BOOK, USER);
  const keep = mk('Kellerszene ausbauen');
  const dup1 = mk('Keller-Szene länger');
  const dup2 = ideenDb.createIdee({ bookId: BOOK, userEmail: USER, content: 'Keller mehr Raum' });
  ideenDb.addIdeaLink(keep, BOOK, 'research', 8330, USER);
  ideenDb.addIdeaLink(dup1, BOOK, 'research', 8330, USER);
  ideenDb.addIdeaLink(dup2, BOOK, 'research', 8331, USER);

  assert.deepEqual(ideenDb.mergeIdeen(keep, [dup1], OTHER, null), { error_code: 'IDEE_NOT_FOUND' });
  const r = ideenDb.mergeIdeen(keep, [dup1, dup2], USER, 'Kellerszene ausbauen, mehr Raum');
  assert.deepEqual(r, { ok: true });
  const row = ideenDb.getIdee(keep);
  assert.equal(row.content, 'Kellerszene ausbauen, mehr Raum');
  assert.equal(row.page_id, PAGE, 'Ort des Ziels bleibt');
  assert.deepEqual(row.links.map(l => l.target_id).sort(), [8330, 8331], 'Links ohne Doppelkante');
  assert.equal(ideenDb.getIdee(dup1), null);
  assert.equal(ideenDb.getIdee(dup2), null);

  const closed = mk('erledigte Fassung');
  ideenDb.updateIdee(closed, USER, { status: 'erledigt' });
  const open = mk('offene Fassung');
  assert.deepEqual(ideenDb.mergeIdeen(closed, [open], USER, null), { error_code: 'MERGE_TARGET_CLOSED' });
  assert.ok(ideenDb.getIdee(open), 'nichts geschrieben');
});

test('updateIdee: neuer Ort verwirft den Hinweis, gleicher Ort und Textänderung nicht', () => {
  const PAGE2 = 8330102;
  db.prepare(`INSERT OR IGNORE INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Der Dachboden', '<p>x</p>', ?)`).run(PAGE2, BOOK, NOW);
  const id = mk('Kellertür abschliessen');
  ideenCheck.setHint(id, USER, { pageId: PAGE, beleg: 'schliesst Lea die Tür' });
  ideenDb.updateIdee(id, USER, { content: 'Kellertür abschliessen (nachts)' });
  assert.ok(hintOf(id), 'Textänderung lässt den Hinweis stehen');
  ideenDb.updateIdee(id, USER, { page_id: PAGE, chapter_id: null });
  assert.ok(hintOf(id), 'gleicher Ort lässt den Hinweis stehen');
  ideenDb.updateIdee(id, USER, { page_id: PAGE2, chapter_id: null });
  assert.equal(hintOf(id), null, 'neuer Ort verwirft ihn');
});

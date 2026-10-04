'use strict';
// Integration test: Buchbewertung (review.js) — Pflichtfeld-Prüfung vor dem
// Cache, Cache-Signatur über die System-Prompts, Historie ohne Duplikate,
// Synthese-Cache und zerlegte Kapitel im Multi-Pass.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

const USER = 'tester@test.dev';

function reviewResponse(note = 4.5) {
  return {
    zusammenfassung: 'Buch über Anna.',
    struktur: 'klar',
    stil: 'flüssig',
    staerken: ['Atmosphäre'],
    schwaechen: ['Pacing'],
    empfehlungen: [],
    fazit: 'lesenswert',
    gesamtnote: note,
    gesamtnote_begruendung: 'solide',
  };
}

function chapterAnalysisResponse() {
  return {
    themen: 'Aufbruch',
    stil: 'erzählerisch',
    funktion_kurz: 'führt Anna ein',
    staerken: ['Bilder'],
    schwaechen: ['kurz'],
  };
}

const isReview = (e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('struktur');
const isAnalysis = (e) => e.schemaKeys.includes('themen') && e.schemaKeys.includes('funktion_kurz');

async function runReview(bookId) {
  const jobId = ctx.shared.createJob('review', bookId, USER, 'job.label.review');
  ctx.shared.enqueueJob(jobId, () => ctx.review.runReviewJob(jobId, bookId, 'Mein Buch', USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
}

function seedSmallBook(bookId, chapterId, pageId) {
  ctx.dbSeed.setBook({
    chapters: [{ id: chapterId, book_id: bookId, name: 'Kap 1' }],
    pages: [{ id: pageId, book_id: bookId, chapter_id: chapterId, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [pageId]: '<p>' + 'Anna ging weiter. '.repeat(60) + '</p>' },
  });
}

// 3 Seiten × ~40K Zeichen = 120K → Multi-Pass (SINGLE_PASS_LIMIT 113400 aus dem
// Test-Budget in _helpers/setup.js); je Seite ein Chunk (PER_CHUNK_LIMIT ~56K).
const LONG_BODY = '<p>' + 'Anna ging weiter durch das Land. '.repeat(1215) + '</p>';

function reviewRows(bookId) {
  return ctx.dbSchema.db.prepare('SELECT id FROM book_reviews WHERE book_id = ? AND user_email = ?').all(bookId, USER);
}

test('Buch-Review: Note ausserhalb 1–6 → failJob und KEIN Cache-Eintrag', async () => {
  const BOOK_ID = 120;
  seedSmallBook(BOOK_ID, 12000, 12001);
  let calls = 0;
  ctx.mockAi.on(isReview, () => reviewResponse(++calls === 1 ? 7 : 4.5));

  const job1 = await runReview(BOOK_ID);
  assert.equal(job1.status, 'error');
  assert.equal(job1.error, 'job.error.gesamtnoteInvalid');
  const cacheRow = ctx.dbSchema.db.prepare('SELECT 1 FROM book_review_cache WHERE book_id = ?').get(BOOK_ID);
  assert.equal(cacheRow, undefined, 'ungültiges Ergebnis darf nicht im Cache landen');

  // Nächster Lauf fragt die KI erneut, statt den Fehler aus dem Cache zu wiederholen.
  const job2 = await runReview(BOOK_ID);
  assert.equal(job2.status, 'done', `expected done, got ${job2.status}: ${job2.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 2);
});

test('Buch-Review: Note als Zahl-String wird zur Zahl', async () => {
  const BOOK_ID = 121;
  seedSmallBook(BOOK_ID, 12100, 12101);
  ctx.mockAi.on(isReview, { ...reviewResponse(), gesamtnote: '4.5' });
  const job = await runReview(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.review.gesamtnote, 4.5);
});

test('Buch-Review Cache: geänderter Buch-Kontext invalidiert den Cache', async () => {
  const BOOK_ID = 122;
  seedSmallBook(BOOK_ID, 12200, 12201);
  ctx.mockAi.on(isReview, reviewResponse(4.5));

  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', null, 'Ein stiller Roman.');
  assert.equal((await runReview(BOOK_ID)).status, 'done');
  assert.equal(ctx.mockAi.log.length, 1);

  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', null, 'Ein lauter Roman.');
  assert.equal((await runReview(BOOK_ID)).status, 'done');
  assert.equal(ctx.mockAi.log.length, 2, 'neuer Buch-Kontext = neuer Systemprompt = Cache-Miss');
  assert.match(ctx.mockAi.log[1].system, /Ein lauter Roman\./);
});

test('Buch-Review: Rerun ohne Textänderung → unchanged, keine Duplikat-Zeile', async () => {
  const BOOK_ID = 123;
  seedSmallBook(BOOK_ID, 12300, 12301);
  ctx.mockAi.on(isReview, reviewResponse(4.5));

  const job1 = await runReview(BOOK_ID);
  assert.equal(job1.status, 'done');
  assert.equal(job1.result.unchanged, false);
  assert.equal(reviewRows(BOOK_ID).length, 1);

  const job2 = await runReview(BOOK_ID);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.unchanged, true);
  assert.equal(reviewRows(BOOK_ID).length, 1, 'Cache-Treffer schreibt keine zweite Zeile');
  assert.equal(ctx.mockAi.log.length, 1);

  // Gelöschter Eintrag kommt beim nächsten (Cache-)Lauf wieder hinein.
  ctx.dbSchema.deleteBookReview(reviewRows(BOOK_ID)[0].id, USER);
  const job3 = await runReview(BOOK_ID);
  assert.equal(job3.result.unchanged, false);
  assert.equal(reviewRows(BOOK_ID).length, 1);
});

test('Buch-Review Multi-Pass: Rerun trifft auch den Synthese-Cache → 0 Calls', async () => {
  const BOOK_ID = 124;
  const chapters = [], pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    chapters.push({ id: 12400 + i, book_id: BOOK_ID, name: `Kap ${i + 1}` });
    pages.push({ id: 12410 + i, book_id: BOOK_ID, chapter_id: 12400 + i, name: `S ${i + 1}`, updated_at: '2026-05-01T10:00:00Z' });
    bodies[12410 + i] = LONG_BODY;
  }
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });
  ctx.mockAi.on(isAnalysis, chapterAnalysisResponse());
  ctx.mockAi.on(isReview, reviewResponse(3.5));

  const job1 = await runReview(BOOK_ID);
  assert.equal(job1.status, 'done', `expected done, got ${job1.status}: ${job1.error || ''}`);
  assert.equal(job1.result.review.basis, 'multi');
  assert.equal(ctx.mockAi.log.length, 4);

  const job2 = await runReview(BOOK_ID);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.unchanged, true);
  assert.equal(ctx.mockAi.log.length, 4, 'Kapitel UND Synthese aus dem Cache');
});

test('Buch-Review Multi-Pass: zerlegtes Kapitel zählt als EIN Kapitel', async () => {
  const BOOK_ID = 125;
  const CH = 12500;
  const pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    pages.push({ id: 12510 + i, book_id: BOOK_ID, chapter_id: CH, name: `S ${i + 1}`, position: i, updated_at: '2026-05-01T10:00:00Z' });
    bodies[12510 + i] = LONG_BODY;
  }
  ctx.dbSeed.setBook({ chapters: [{ id: CH, book_id: BOOK_ID, name: 'Lang' }], pages, pageBodies: bodies });
  ctx.mockAi.on(isAnalysis, chapterAnalysisResponse());
  ctx.mockAi.on(isReview, reviewResponse(4.0));

  const job = await runReview(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  const analyses = ctx.mockAi.log.filter(isAnalysis);
  assert.equal(analyses.length, 3);
  analyses.forEach((a, i) => assert.match(a.prompt, new RegExp(`Teil ${i + 1} von 3 des Kapitels «Lang»`)));

  const synth = ctx.mockAi.log.find(isReview).prompt;
  assert.match(synth, /<kapitelanalysen kapitel="1" analysen="3"/);
  assert.match(synth, /## Kapitel 1: Lang, Teil 2\/3/);
  assert.doesNotMatch(synth, /## Kapitel 2:/);
});

test('Buch-Review Multi-Pass: leere Kapitelanalyse → failJob, kein Kapitel-Cache', async () => {
  const BOOK_ID = 126;
  const chapters = [], pages = [], bodies = {};
  for (let i = 0; i < 3; i++) {
    chapters.push({ id: 12600 + i, book_id: BOOK_ID, name: `Kap ${i + 1}` });
    pages.push({ id: 12610 + i, book_id: BOOK_ID, chapter_id: 12600 + i, name: `S ${i + 1}`, updated_at: '2026-05-01T10:00:00Z' });
    bodies[12610 + i] = LONG_BODY;
  }
  ctx.dbSeed.setBook({ chapters, pages, pageBodies: bodies });
  ctx.mockAi.on(isAnalysis, { themen: '', stil: '', funktion_kurz: '  ', staerken: [], schwaechen: [] });
  ctx.mockAi.on(isReview, reviewResponse(4.0));

  const job = await runReview(BOOK_ID);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.chapterAnalysisEmpty');
  const cached = ctx.dbSchema.db.prepare('SELECT COUNT(*) AS n FROM chapter_review_cache WHERE book_id = ?').get(BOOK_ID);
  assert.equal(cached.n, 0);
});

test('Buch-Review Multi-Pass: Seiten ohne Kapitel werden gecacht (ungrouped_review_cache)', async () => {
  const BOOK_ID = 127;
  const pages = [
    { id: 12710, book_id: BOOK_ID, chapter_id: 12700, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
    { id: 12711, book_id: BOOK_ID, chapter_id: 12701, name: 'S 2', updated_at: '2026-05-01T10:00:00Z' },
    { id: 12712, book_id: BOOK_ID, chapter_id: null, name: 'Vorwort', updated_at: '2026-05-01T10:00:00Z' },
  ];
  ctx.dbSeed.setBook({
    chapters: [{ id: 12700, book_id: BOOK_ID, name: 'Kap 1' }, { id: 12701, book_id: BOOK_ID, name: 'Kap 2' }],
    pages,
    pageBodies: { 12710: LONG_BODY, 12711: LONG_BODY, 12712: LONG_BODY },
  });
  ctx.mockAi.on(isAnalysis, chapterAnalysisResponse());
  ctx.mockAi.on(isReview, reviewResponse(4.0));

  const job1 = await runReview(BOOK_ID);
  assert.equal(job1.status, 'done', `expected done, got ${job1.status}: ${job1.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 4, '3 Analysen (davon 1 ohne Kapitel) + 1 Synthese');
  const row = ctx.dbSchema.db.prepare(
    'SELECT phase FROM ungrouped_review_cache WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, USER);
  assert.ok(row, 'ungrouped_review_cache-Zeile fehlt');
  assert.equal(row.phase, '');

  // Synthese-Cache umgehen, damit der Kapitel-Cache allein geprüft wird.
  ctx.dbSchema.db.prepare('DELETE FROM book_review_cache WHERE book_id = ?').run(BOOK_ID);
  const job2 = await runReview(BOOK_ID);
  assert.equal(job2.status, 'done');
  assert.equal(ctx.mockAi.log.length, 5, 'nur die Synthese läuft neu — alle drei Analysen aus dem Cache');

  // History-Reset-Pfad leert auch diese Tabelle.
  assert.ok(ctx.dbSchema.deleteReviewCache(BOOK_ID, USER) >= 3);
  const left = ctx.dbSchema.db.prepare('SELECT COUNT(*) AS n FROM ungrouped_review_cache WHERE book_id = ?').get(BOOK_ID);
  assert.equal(left.n, 0);
});

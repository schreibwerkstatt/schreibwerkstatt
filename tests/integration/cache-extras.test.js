'use strict';
// Integration test: Cache für Lektorat (Single + Batch) und Synonyme.

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

function lektoratResponse(errorCount = 1) {
  const fehler = [];
  for (let i = 0; i < errorCount; i++) {
    fehler.push({
      typ: 'rechtschreibung',
      original: 'fehler',
      korrektur: 'Fehler',
      erklaerung: 'Substantive werden grossgeschrieben.',
    });
  }
  return { fehler, szenen: [], stilanalyse: 'ok', fazit: 'ok' };
}

// ── Lektorat Single-Check ────────────────────────────────────────────────────

test('Lektorat-Cache: identischer Re-Run trifft lektorat_cache → 0 AI-Calls', async () => {
  const BOOK_ID = 200;
  const PAGE_ID = 2001;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2010, book_id: BOOK_ID, name: 'Kap A' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2010, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Anna ging in den wald.</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(2),
  );

  const jobId1 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runCheckJob(jobId1, PAGE_ID, BOOK_ID, 'tester@test.dev'),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done', `expected done, got ${job1.status}: ${job1.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 1, '1. Run = 1 AI-Call');

  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT ctx_sig FROM lektorat_cache WHERE book_id = ? AND page_id = ? AND user_email = ?'
  ).get(BOOK_ID, PAGE_ID, 'tester@test.dev');
  assert.ok(cacheRow, 'lektorat_cache fehlt nach 1. Run');

  // 2. Run, gleiche Seite, gleicher updated_at → HIT.
  const jobId2 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runCheckJob(jobId2, PAGE_ID, BOOK_ID, 'tester@test.dev'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1, '2. Run = Cache-HIT');
  assert.deepEqual(job2.result.fehler, job1.result.fehler, 'identische Fehler-Liste');
});

test('Lektorat-Cache: updated_at-Wechsel invalidiert Cache', async () => {
  const BOOK_ID = 201;
  const PAGE_ID = 2011;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2020, book_id: BOOK_ID, name: 'Kap B' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2020, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Test.</p>' },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId1 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runCheckJob(jobId1, PAGE_ID, BOOK_ID, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId1);
  assert.equal(ctx.mockAi.log.length, 1);

  // Seite ändert sich.
  ctx.dbSeed.setBook({
    chapters: [{ id: 2020, book_id: BOOK_ID, name: 'Kap B' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2020, name: 'S 1', updated_at: '2026-05-02T11:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Test geändert.</p>' },
  });

  const jobId2 = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runCheckJob(jobId2, PAGE_ID, BOOK_ID, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId2);
  assert.equal(ctx.mockAi.log.length, 2, 'updated_at-Wechsel → MISS, 2 Calls insgesamt');
});

async function runCheck(bookId, pageId) {
  const jobId = ctx.shared.createJob('check', bookId, 'tester@test.dev', 'job.label.checkPage', null, pageId);
  ctx.shared.enqueueJob(jobId, () => ctx.lektorat.runCheckJob(jobId, pageId, bookId, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  return job;
}

// Die Buch-Angaben stehen im System-Prompt, nicht im User-Prompt. Ohne
// System-Hash in der Signatur lieferte der Cache nach einer Änderung der
// «Vorrangigen Angaben» das Ergebnis des alten Kontexts.
test('Lektorat-Cache: geänderte Buch-Angaben (buch_kontext) invalidieren den Cache', async () => {
  const BOOK_ID = 203;
  const PAGE_ID = 2041;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2040, book_id: BOOK_ID, name: 'Kap D' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2040, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Anna ging in den wald.</p>' },
  });
  ctx.mockAi.on((e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'), lektoratResponse(1));

  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', null, 'Mundart ist gewollt.');
  await runCheck(BOOK_ID, PAGE_ID);
  await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(ctx.mockAi.log.length, 1, 'gleiche Angaben → HIT');

  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', null, 'Hochdeutsch, keine Mundart.');
  await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(ctx.mockAi.log.length, 2, 'andere Angaben → MISS');

  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'DE', null, 'Hochdeutsch, keine Mundart.');
  await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(ctx.mockAi.log.length, 3, 'andere Region (de-CH → de-DE) → MISS');
});

// History-Dedup: ein identischer Lauf legt keinen neuen Eintrag an — ausser aus
// dem jüngsten wurde schon übernommen. Dann ist ein erneut gemeldetes `original`
// ein weiteres Vorkommen und gehört an einen eigenen Eintrag (Heatmap-Zählregel).
test('History-Dedup: nur ohne Übernahmen am jüngsten Eintrag', async () => {
  const BOOK_ID = 204;
  const PAGE_ID = 2051;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2050, book_id: BOOK_ID, name: 'Kap E' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2050, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Ein fehler hier und ein fehler dort.</p>' },
  });
  ctx.mockAi.on((e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'), lektoratResponse(1));
  const count = () => ctx.dbSchema.db.prepare('SELECT COUNT(*) AS n FROM page_checks WHERE page_id = ?').get(PAGE_ID).n;

  const j1 = await runCheck(BOOK_ID, PAGE_ID);
  const j2 = await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(count(), 1, 'identischer Lauf → kein neuer Eintrag');
  assert.equal(j2.result.checkId, j1.result.checkId);

  ctx.dbSchema.db.prepare('UPDATE page_checks SET saved = 1, saved_at = ?, applied_errors_json = ? WHERE id = ?')
    .run(new Date().toISOString(), JSON.stringify([{ typ: 'rechtschreibung', original: 'fehler', korrektur: 'Fehler' }]), j1.result.checkId);
  const j3 = await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(count(), 2, 'nach Übernahme → eigener Eintrag');
  assert.notEqual(j3.result.checkId, j1.result.checkId);
});

// Ein mehrfach vorkommendes `original` ist beim Übernehmen nicht eindeutig.
test('Lektorat: mehrdeutige Fundstelle trägt mehrdeutig=true, auch aus dem Cache', async () => {
  const BOOK_ID = 205;
  const PAGE_ID = 2061;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2060, book_id: BOOK_ID, name: 'Kap F' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2060, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' }],
    pageBodies: { [PAGE_ID]: '<p>Ein fehler hier und ein fehler dort.</p>' },
  });
  ctx.mockAi.on((e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'), lektoratResponse(1));
  const j1 = await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(j1.result.fehler[0].mehrdeutig, true);
  const j2 = await runCheck(BOOK_ID, PAGE_ID);
  assert.equal(ctx.mockAi.log.length, 1);
  assert.equal(j2.result.fehler[0].mehrdeutig, true);
});

// ── Lektorat Batch ───────────────────────────────────────────────────────────

test('Batch-Lektorat-Cache: zweiter Lauf nur für geänderte Seite', async () => {
  const BOOK_ID = 202;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2030, book_id: BOOK_ID, name: 'Kap C' }],
    pages: [
      { id: 2031, book_id: BOOK_ID, chapter_id: 2030, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2032, book_id: BOOK_ID, chapter_id: 2030, name: 'S 2', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2033, book_id: BOOK_ID, chapter_id: 2030, name: 'S 3', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2034, book_id: BOOK_ID, chapter_id: 2030, name: 'S 4', updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      2031: '<p>Seite eins inhaltsreich.</p>',
      2032: '<p>Seite zwei inhaltsreich.</p>',
      2033: '<p>Seite drei inhaltsreich.</p>',
      2034: '<p>Seite vier inhaltsreich.</p>',
    },
  });

  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId1 = ctx.shared.createJob('batch-check', BOOK_ID, 'tester@test.dev', 'job.label.batchCheck');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.lektorat.runBatchCheckJob(jobId1, BOOK_ID, 'tester@test.dev'),
  );
  const job1 = await waitForJob(ctx.shared, jobId1, { timeoutMs: 8000 });
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 4, '1. Batch = 4 Seiten-Calls');

  // Eine Seite ändert sich.
  ctx.dbSeed.setBook({
    chapters: [{ id: 2030, book_id: BOOK_ID, name: 'Kap C' }],
    pages: [
      { id: 2031, book_id: BOOK_ID, chapter_id: 2030, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2032, book_id: BOOK_ID, chapter_id: 2030, name: 'S 2', updated_at: '2026-05-03T12:00:00Z' },
      { id: 2033, book_id: BOOK_ID, chapter_id: 2030, name: 'S 3', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2034, book_id: BOOK_ID, chapter_id: 2030, name: 'S 4', updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      2031: '<p>Seite eins inhaltsreich.</p>',
      2032: '<p>Seite zwei NEU.</p>',
      2033: '<p>Seite drei inhaltsreich.</p>',
      2034: '<p>Seite vier inhaltsreich.</p>',
    },
  });

  ctx.mockAi.reset();
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const jobId2 = ctx.shared.createJob('batch-check', BOOK_ID, 'tester@test.dev', 'job.label.batchCheck');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.lektorat.runBatchCheckJob(jobId2, BOOK_ID, 'tester@test.dev'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 8000 });
  assert.equal(job2.status, 'done');
  // Seite 2032 ändert sich → MISS. Ihre Nachbarn sehen sie als Auszug:
  // 2031 als Folgeseite (nextExcerpt), 2033 als Vorseite (previousExcerpt) →
  // beide MISS. Seite 2034 bleibt HIT.
  assert.equal(ctx.mockAi.log.length, 3, '2. Batch = 3 Calls (geänderte Seite + beide Nachbarn via Auszug)');
});

test('Lektorat-Cache: Seiten-Lektorat nach Buch-Lektorat trifft denselben Cache', async () => {
  const BOOK_ID = 203;
  ctx.dbSeed.setBook({
    chapters: [{ id: 2040, book_id: BOOK_ID, name: 'Kap D' }],
    pages: [
      { id: 2041, book_id: BOOK_ID, chapter_id: 2040, name: 'S 1', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2042, book_id: BOOK_ID, chapter_id: 2040, name: 'S 2', updated_at: '2026-05-01T10:00:00Z' },
      { id: 2043, book_id: BOOK_ID, chapter_id: 2040, name: 'S 3 leer', updated_at: '2026-05-01T10:00:00Z' },
    ],
    pageBodies: {
      2041: '<p>Seite eins inhaltsreich.</p>',
      2042: '<p>Seite zwei inhaltsreich.</p>',
      2043: '<p></p>',
    },
  });
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    lektoratResponse(1),
  );

  const batchId = ctx.shared.createJob('batch-check', BOOK_ID, 'tester@test.dev', 'job.label.batchCheck');
  ctx.shared.enqueueJob(batchId, () => ctx.lektorat.runBatchCheckJob(batchId, BOOK_ID, 'tester@test.dev'));
  const batch = await waitForJob(ctx.shared, batchId, { timeoutMs: 8000 });
  assert.equal(batch.status, 'done');
  assert.equal(ctx.mockAi.log.length, 2, 'zwei nicht-leere Seiten');
  assert.equal(batch.result.done, 2);
  assert.equal(batch.result.skippedEmpty, 1, 'leere Seite wird gezählt, nicht verschluckt');
  assert.deepEqual(batch.result.failed, []);

  const checkId = ctx.shared.createJob('check', BOOK_ID, 'tester@test.dev', 'job.label.checkPage', null, 2042);
  ctx.shared.enqueueJob(checkId, () => ctx.lektorat.runCheckJob(checkId, 2042, BOOK_ID, 'tester@test.dev'));
  const check = await waitForJob(ctx.shared, checkId);
  assert.equal(check.status, 'done', `expected done, got ${check.status}: ${check.error || ''}`);
  assert.equal(ctx.mockAi.log.length, 2, 'Seiten-Lektorat = Cache-HIT aus dem Buch-Lektorat');
});

// ── Synonym-Cache ────────────────────────────────────────────────────────────

test('Synonym-Cache: identischer Lookup → 0 AI-Calls', async () => {
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('synonyme'),
    { synonyme: [{ wort: 'Wald', hinweis: 'Forst' }, { wort: 'Hain', hinweis: '' }] },
  );

  const jobId1 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'Forst' }, 'wald|satz');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.synonyme.runSynonymJob(jobId1, 'Wald', 'Anna ging in den Wald.', null, 'tester@test.dev'),
  );
  const job1 = await waitForJob(ctx.shared, jobId1);
  assert.equal(job1.status, 'done');
  assert.equal(ctx.mockAi.log.length, 1);
  assert.equal(job1.result.synonyme.length, 1, '"Wald" selbst rausgefiltert');

  // Cache geschrieben.
  const cacheRow = ctx.dbSchema.db.prepare(
    'SELECT key_hash FROM synonym_cache WHERE user_email = ?'
  ).get('tester@test.dev');
  assert.ok(cacheRow, 'synonym_cache fehlt');

  // 2. Lookup identische Eingaben → HIT.
  const jobId2 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'Forst' }, 'wald|satz|2');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.synonyme.runSynonymJob(jobId2, 'Wald', 'Anna ging in den Wald.', null, 'tester@test.dev'),
  );
  const job2 = await waitForJob(ctx.shared, jobId2);
  assert.equal(job2.status, 'done');
  assert.equal(job2.result.cached, true);
  assert.equal(ctx.mockAi.log.length, 1, '2. Lookup = Cache-HIT');
});

test('Synonym-Job: ai.claude.model.synonym landet in job_runs (Kosten-Ledger)', async () => {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('ai.claude.model', 'claude-opus-5-5', { updatedBy: 'test' });
  appSettings.set('ai.claude.model.synonym', 'claude-sonnet-5-5', { updatedBy: 'test' });
  try {
    ctx.mockAi.on(
      (e) => e.schemaKeys.includes('synonyme'),
      { synonyme: [{ wort: 'Hain', hinweis: '' }] },
    );
    const jobId = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'Wald' }, 'wald|modell');
    ctx.shared.enqueueJob(jobId, () =>
      ctx.synonyme.runSynonymJob(jobId, 'Wald', 'Ein Satz fürs Modell.', null, 'tester@test.dev'),
    );
    const job = await waitForJob(ctx.shared, jobId);
    assert.equal(job.status, 'done');
    const row = ctx.dbSchema.db.prepare('SELECT model FROM job_runs WHERE job_id = ?').get(jobId);
    assert.equal(row.model, 'claude-sonnet-5-5');
  } finally {
    appSettings.set('ai.claude.model.synonym', '', { updatedBy: 'test' });
  }
});

test('Synonym-Cache: anderer Satz → MISS', async () => {
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('synonyme'),
    { synonyme: [{ wort: 'Hain', hinweis: '' }] },
  );

  const jobId1 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'A' }, 'wald|s1');
  ctx.shared.enqueueJob(jobId1, () =>
    ctx.synonyme.runSynonymJob(jobId1, 'Wald', 'Erster Satz.', null, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId1);
  assert.equal(ctx.mockAi.log.length, 1);

  const jobId2 = ctx.shared.createJob('synonym', 0, 'tester@test.dev', 'job.label.synonymWord', { word: 'B' }, 'wald|s2');
  ctx.shared.enqueueJob(jobId2, () =>
    ctx.synonyme.runSynonymJob(jobId2, 'Wald', 'Zweiter, anderer Satz.', null, 'tester@test.dev'),
  );
  await waitForJob(ctx.shared, jobId2);
  assert.equal(ctx.mockAi.log.length, 2, 'anderer Satz → MISS');
});

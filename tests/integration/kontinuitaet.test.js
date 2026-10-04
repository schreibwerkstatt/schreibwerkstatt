'use strict';
// Integration test: runKontinuitaetJob single-pass.
// Mocks lib/ai + content-store, runs the full pipeline against a fresh
// in-memory-ish DB, verifies job completes and DB has the continuity check.

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

test('Kontinuität single-pass: 1 Kapitel, 1 Seite, AI liefert 1 Problem', async () => {
  const BOOK_ID = 42;

  ctx.dbSeed.setBook({
    chapters: [{ id: 100, book_id: BOOK_ID, name: 'Kapitel Eins' }],
    pages: [{ id: 200, book_id: BOOK_ID, chapter_id: 100, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: {
      200: '<p>' + 'Wald und Sonne. '.repeat(50) + '</p>',
    },
  });

  ctx.mockAi.on(
    (entry) => entry.schemaKeys.includes('zusammenfassung') && entry.schemaKeys.includes('probleme'),
    {
      zusammenfassung: 'Insgesamt konsistent, ein Detail-Widerspruch.',
      probleme: [{
        schwere: 'mittel',
        typ: 'detail',
        beschreibung: 'Sonne mal hell, mal trübe',
        stelle_a: 'Seite 1',
        stelle_b: 'Seite 1',
        empfehlung: 'vereinheitlichen',
        figuren: [],
        kapitel: ['Kapitel Eins'],
      }],
    },
  );

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.count, 1);
  assert.equal(job.result.zusammenfassung, 'Insgesamt konsistent, ein Detail-Widerspruch.');
  assert.equal(job.result.issues.length, 1);
  assert.equal(job.result.issues[0].kapitel[0], 'Kapitel Eins');

  const stored = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, 'tester@test.dev');
  assert.ok(stored, 'continuity_checks row missing');
  assert.equal(stored.summary, 'Insgesamt konsistent, ein Detail-Widerspruch.');
  assert.equal(stored.issues.length, 1);

  assert.equal(ctx.mockAi.log.length, 1, 'expected exactly 1 AI call for single-pass');
});

test('Kontinuität single-pass: erfundenes Beleg-Zitat wird verworfen, echtes bleibt', async () => {
  const BOOK_ID = 45;
  ctx.dbSeed.setBook({
    chapters: [{ id: 120, book_id: BOOK_ID, name: 'Kapitel Eins' }],
    pages: [{ id: 220, book_id: BOOK_ID, chapter_id: 120, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 220: '<p>' + 'Wald und Sonne. '.repeat(50) + '</p>' },
  });

  ctx.mockAi.on(
    (entry) => entry.schemaKeys.includes('zusammenfassung') && entry.schemaKeys.includes('probleme'),
    {
      zusammenfassung: 'Ein echter, ein erfundener Widerspruch.',
      probleme: [
        { schwere: 'mittel', typ: 'detail', beschreibung: 'echter Widerspruch',
          stelle_a: 'Kapitel Eins: «Wald und Sonne»', stelle_b: 'Kapitel Eins: «Wald und Sonne»',
          empfehlung: 'x', figuren: [], kapitel: ['Kapitel Eins'] },
        { schwere: 'kritisch', typ: 'figur', beschreibung: 'halluziniert',
          stelle_a: 'Kapitel Eins: «Drachen und Raumschiffe»', stelle_b: 'Kapitel Eins: «niemals im Text»',
          empfehlung: 'x', figuren: [], kapitel: ['Kapitel Eins'] },
      ],
    },
  );

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.count, 1, 'erfundenes Zitat muss verworfen werden, echtes bleibt');
  assert.equal(job.result.issues[0].beschreibung, 'echter Widerspruch');
});

test('Kontinuität: leeres Buch → result.empty', async () => {
  const BOOK_ID = 43;
  ctx.dbSeed.setBook({ chapters: [], pages: [], pageBodies: {}, books: [{ id: BOOK_ID, name: 'Leer' }] });

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Leeres Buch', 'tester@test.dev', 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0, 'no AI call expected when book empty');
});

test('Kontinuität: AI ohne zusammenfassung → failJob', async () => {
  const BOOK_ID = 44;
  ctx.dbSeed.setBook({
    chapters: [{ id: 110, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 210, book_id: BOOK_ID, chapter_id: 110, name: 'S1', updated_at: '' }],
    pageBodies: { 210: '<p>' + 'x'.repeat(200) + '</p>' },
  });

  ctx.mockAi.on(() => true, { probleme: [] }); // missing zusammenfassung

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Buch', 'tester@test.dev', 'claude'),
  );

  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.zusammenfassungMissing');
});

test('Kontinuität multi-pass: nachgeholtes Kapitel bleibt in Buchreihenfolge, Seiten-Anker über den Fakt', async () => {
  const BOOK_ID = 46;
  const big = (w) => '<p>' + `${w} `.repeat(14000) + '</p>';
  ctx.dbSeed.setBook({
    chapters: [
      { id: 130, book_id: BOOK_ID, name: 'Kapitel Eins' },
      { id: 131, book_id: BOOK_ID, name: 'Kapitel Zwei' },
      { id: 132, book_id: BOOK_ID, name: 'Kapitel Drei' },
    ],
    pages: [
      { id: 230, book_id: BOOK_ID, chapter_id: 130, name: 'Anfang', updated_at: '2026-01-01' },
      { id: 231, book_id: BOOK_ID, chapter_id: 131, name: 'Mitte', updated_at: '2026-01-01' },
      { id: 232, book_id: BOOK_ID, chapter_id: 132, name: 'Ende', updated_at: '2026-01-01' },
    ],
    pageBodies: { 230: big('Nebel'), 231: big('Regen'), 232: big('Schnee') },
  });

  let einsFailed = false;
  ctx.mockAi.on(
    (entry) => entry.schemaKeys.includes('fakten'),
    ({ prompt }) => {
      const m = prompt.match(/Kapitel «([^»]+)»/);
      const kap = m ? m[1] : '?';
      if (kap === 'Kapitel Eins' && !einsFailed) { einsFailed = true; throw new Error('kaputt'); }
      const seite = { 'Kapitel Eins': 'Anfang', 'Kapitel Zwei': 'Mitte', 'Kapitel Drei': 'Ende' }[kap];
      return { fakten: [{ kategorie: 'figur', subjekt: 'Anna', fakt: `ist in ${kap} anwesend`, seite }] };
    },
  );
  ctx.mockAi.on(
    (entry) => entry.schemaKeys.includes('zusammenfassung') && entry.schemaKeys.includes('probleme'),
    {
      zusammenfassung: 'Ein Widerspruch.',
      probleme: [{
        schwere: 'mittel', typ: 'figur', beschreibung: 'Anna ist an zwei Orten zugleich.',
        stelle_a: 'Kapitel Zwei: «Anna: ist in Kapitel Zwei anwesend»',
        stelle_b: 'Kapitel Drei: «Anna: ist in Kapitel Drei anwesend»',
        empfehlung: 'Ort klären.', figuren: [], kapitel: ['Kapitel Zwei', 'Kapitel Drei'],
      }],
    },
  );
  ctx.mockAi.on((entry) => entry.schemaKeys.includes('bestaetigt'), { bestaetigt: true, grund: 'echt' });

  const jobId = ctx.shared.createJob('kontinuitaet', BOOK_ID, 'tester@test.dev', 'job.label.kontinuitaet');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKontinuitaetJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.ok(einsFailed, 'Kapitel Eins ist im ersten Durchgang gescheitert (Multi-Pass aktiv)');

  const checkCall = ctx.mockAi.log.find(e => e.schemaKeys.includes('probleme'));
  const order = [...checkCall.prompt.matchAll(/^## (Kapitel \w+)$/gm)].map(m => m[1]);
  assert.deepEqual(order, ['Kapitel Eins', 'Kapitel Zwei', 'Kapitel Drei'], 'Buchreihenfolge trotz Retry');

  const stored = ctx.dbSchema.getLatestContinuityCheck(BOOK_ID, 'tester@test.dev');
  assert.equal(stored.issues.length, 1);
  assert.equal(stored.issues[0].page_a_id, 231, 'Anker über den Seitennamen des zitierten Fakts');
  assert.equal(stored.issues[0].page_b_id, 232);
});

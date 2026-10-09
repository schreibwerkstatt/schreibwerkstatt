'use strict';
// Integration: Abschnitts-Lektorat liefert den Fortschritt gegenüber dem Vorlauf
// derselben Seite als `result.progress` (docs/lektorat.md).

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

const BOOK_ID = 210;
const PAGE_ID = 2101;
const USER = 'tester@test.dev';

function seed(body, updatedAt) {
  ctx.dbSeed.setBook({
    chapters: [{ id: 2110, book_id: BOOK_ID, name: 'Kap P' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, chapter_id: 2110, name: 'S 1', updated_at: updatedAt }],
    pageBodies: { [PAGE_ID]: body },
  });
}

async function runCheck(fehler) {
  ctx.mockAi.reset();
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('fehler') && e.schemaKeys.includes('szenen'),
    { fehler, szenen: [], stilanalyse: 'ok', fazit: 'ok' },
  );
  const jobId = ctx.shared.createJob('check', BOOK_ID, USER, 'job.label.checkPage', null, PAGE_ID);
  ctx.shared.enqueueJob(jobId, () => ctx.lektorat.runCheckJob(jobId, PAGE_ID, BOOK_ID, USER));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  return job.result;
}

test('Erster Lauf ohne Vorlauf, zweiter vergleicht gegen den ersten', async () => {
  seed('<p>Anna ging in den wald. Es war eigentlich still.</p>', '2026-05-01T10:00:00Z');
  const r1 = await runCheck([
    { typ: 'rechtschreibung', original: 'wald', korrektur: 'Wald', erklaerung: 'Substantiv.' },
    { typ: 'fuellwort', original: 'eigentlich', korrektur: '', erklaerung: 'Füllwort.' },
  ]);
  assert.equal(r1.progress, null, 'ohne Vorlauf kein Vergleich');

  seed('<p>Anna ging in den Wald. Es war eigentlich still.</p>', '2026-05-02T10:00:00Z');
  const r2 = await runCheck([
    { typ: 'fuellwort', original: 'eigentlich', korrektur: '', erklaerung: 'Füllwort.' },
    { typ: 'stil', original: 'Es war', korrektur: 'Es lag', erklaerung: 'Blass.' },
  ]);
  const p = r2.progress;
  assert.ok(p, 'progress fehlt');
  assert.equal(p.prevCount, 2);
  assert.equal(p.count, 2);
  assert.equal(p.fixed, 1);
  assert.deepEqual(p.fixedItems.map(f => f.original), ['wald']);
  assert.equal(p.remaining, 1);
  assert.equal(p.added, 1);
  assert.equal(p.notReported, 0);
});

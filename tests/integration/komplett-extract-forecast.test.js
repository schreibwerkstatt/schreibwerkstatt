'use strict';
// Integration: Prognose des Extraktions-Caches im Start-Dialog der Komplettanalyse
// (routes/jobs/komplett/extract-plan.js#forecastExtractCache, über ./delta.js).
//
// Die Prognose ist nur so viel wert, wie sie die Keys des Jobs trifft. Darum hier gegen
// einen echten Lauf: danach kommt jedes Kapitel aus dem Cache; eine Bearbeitung kostet
// genau ihr Kapitel; eine geänderte Extraktions-Vorgabe (hier der Effort) alle — und
// die Prognose sagt in diesem Fall `versionChanged`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

const USER = 'tester@test.dev';
const BOOK_ID = 81;

function settings() { return require('../../lib/app-settings'); }

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  const s = settings();
  s.set('ai.komplett.completeness_passes', 1);
  s.set('ai.komplett.coverage_audit_chapters', 0);
  s.set('ai.komplett.attribute_check', false);
  s.set('ai.komplett.narrative_profile', false);
  s.set('ai.claude.effort.komplett.extract', '');
});

// 3 Kapitel à ~40K Zeichen → Multi-Pass (wie komplett-multipass-cache.test.js).
function seedBook(updated = {}) {
  const body = (n) => '<p>' + 'Anna ging weiter durch das Land. '.repeat(n) + '</p>';
  ctx.dbSeed.setBook({
    chapters: [1, 2, 3].map(i => ({ id: 2200 + i, book_id: BOOK_ID, name: `Kapitel ${i}` })),
    pages: [1, 2, 3].map(i => ({
      id: 3200 + i, book_id: BOOK_ID, chapter_id: 2200 + i, name: `Seite ${i}`,
      updated_at: updated[3200 + i] || '2026-01-01',
    })),
    pageBodies: { 3201: body(1215), 3202: body(1215), 3203: body(1215) },
  });
}

const isP1 = (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments');
const isGap = (e) => isP1(e) && e.prompt.includes('bereits_erfasste_figuren');
const chapterOf = (e) => (e.prompt.match(/Kapitel «?(Kapitel \d)/) || [])[1];

function registerMocks() {
  const empty = { figuren: [], orte: [], songs: [], fakten: [], szenen: [], assignments: [] };
  ctx.mockAi.on(isGap, empty);
  ctx.mockAi.on(isP1, (e) => ({
    ...empty,
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', beschreibung: 'Hauptfigur',
      sozialschicht: 'mitte', praesenz: 'zentral', kapitel: [{ name: chapterOf(e) || 'Kapitel 1', haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
    assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
  }));
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'), {
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', beschreibung: 'Hauptfigur',
      sozialschicht: 'mitte', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
  });
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'), { orte: [] });
  // Nachgereihter Prüf-Job Kontinuität.
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    { zusammenfassung: 'Stimmig.', probleme: [], begruendung: '' });
}

async function runJob() {
  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, USER, 'job.label.komplett');
  // Ohne expliziten Provider wie ein Start aus dem Dialog (POST /jobs/komplett-analyse).
  ctx.shared.enqueueJob(jobId, () => ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Buch', USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
}

async function forecast() {
  const { computeKomplettDelta } = require('../../routes/jobs/komplett/delta');
  const d = await computeKomplettDelta(BOOK_ID, USER);
  assert.ok(d.extract, 'Prognose vorhanden');
  return d.extract;
}

test('Prognose trifft die Keys des Jobs: nach dem Lauf alles aus dem Cache', async () => {
  seedBook();
  registerMocks();
  const job = await runJob();
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.passMode, 'multi');

  const f = await forecast();
  assert.equal(f.mode, 'multi');
  assert.equal(f.total, 3);
  assert.equal(f.cached, 3, JSON.stringify(f.chunks));
  assert.equal(f.versionChanged, false);

  // Gegenprobe am Job: ein zweiter Lauf ruft keine Extraktion mehr.
  ctx.mockAi.log.length = 0;
  const again = await runJob();
  assert.equal(again.status, 'done');
  assert.equal(ctx.mockAi.log.filter(isP1).length, 0, 'zweiter Lauf: alle Extraktionen aus dem Cache');
});

test('Prognose: eine Bearbeitung kostet genau ihr Kapitel', async () => {
  seedBook();
  registerMocks();
  assert.equal((await runJob()).status, 'done');

  seedBook({ 3202: '2026-02-01' });
  const f = await forecast();
  assert.equal(f.cached, 2);
  assert.deepEqual(f.chunks.filter(c => !c.cached).map(c => c.name), ['Kapitel 2']);
  assert.equal(f.versionChanged, false);

  ctx.mockAi.log.length = 0;
  assert.equal((await runJob()).status, 'done');
  const base = ctx.mockAi.log.filter(e => isP1(e) && !isGap(e));
  assert.deepEqual(base.map(chapterOf), ['Kapitel 2'], 'Job extrahiert genau das prognostizierte Kapitel');
});

test('Prognose: geänderte Extraktions-Vorgabe → alles neu, versionChanged', async () => {
  seedBook();
  registerMocks();
  assert.equal((await runJob()).status, 'done');

  settings().set('ai.claude.effort.komplett.extract', 'low');
  const f = await forecast();
  assert.equal(f.cached, 0);
  assert.equal(f.versionChanged, true);
});

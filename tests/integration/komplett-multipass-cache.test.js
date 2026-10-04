'use strict';
// Integration: Cloud-Multi-Pass der Komplettanalyse — Kapiteltext als geteilter 1h-Präfix
// und Halbierungs-Retry bei Truncation (routes/jobs/komplett/phases/extraktion.js).
//
// Kostenlogik, die hier festgehalten wird:
//  - Mit Gap-Pass (completeness_passes > 0) steht der Kapiteltext als VORDERSTER
//    System-Block; Basis- und Gap-Call desselben Kapitels haben byte-gleiches System →
//    der Gap-Pass liest den Text aus dem Cache statt ihn neu zu bezahlen.
//  - Ohne Gap-Pass bleibt der Text im User-Turn (ein 1h-Write ohne zweiten Leser wäre
//    teurer als der ungecachte Text).
//  - Ein truncierter Chunk wird einmal seitenweise halbiert, statt nichts beizutragen und
//    in jedem Folgelauf erneut (bezahlt) zu truncieren.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

const USER = 'tester@test.dev';

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  const s = require('../../lib/app-settings');
  s.set('ai.komplett.completeness_passes', 0);
  s.set('ai.komplett.coverage_audit_chapters', 0);
  s.set('ai.komplett.attribute_check', false);
  s.set('ai.komplett.narrative_profile', false);
});

// 3 Kapitel à ~40K Zeichen → Multi-Pass (Grenzen siehe komplett.test.js#seedMultiChapterBook).
// Kapitel 2 hat ZWEI Seiten, damit der Halbierungs-Retry etwas zu teilen hat.
function seedBook(bookId) {
  const body = (n) => '<p>' + 'Anna ging weiter durch das Land. '.repeat(n) + '</p>';
  ctx.dbSeed.setBook({
    chapters: [1, 2, 3].map(i => ({ id: 2100 + i, book_id: bookId, name: `Kapitel ${i}` })),
    pages: [
      { id: 3101, book_id: bookId, chapter_id: 2101, name: 'Seite 1', updated_at: '2026-01-01' },
      { id: 3102, book_id: bookId, chapter_id: 2102, name: 'Seite 2a', updated_at: '2026-01-01' },
      { id: 3112, book_id: bookId, chapter_id: 2102, name: 'Seite 2b', updated_at: '2026-01-01' },
      { id: 3103, book_id: bookId, chapter_id: 2103, name: 'Seite 3', updated_at: '2026-01-01' },
    ],
    pageBodies: { 3101: body(1215), 3102: body(610), 3112: body(610), 3103: body(1215) },
  });
}

function extraktion(chapterName) {
  return {
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
      beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
    orte: [], songs: [], fakten: [], szenen: [],
    assignments: [{ figur_name: 'Anna', lebensereignisse: [] }],
  };
}

const isP1 = (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments');
const isGap = (e) => isP1(e) && e.prompt.includes('bereits_erfasste_figuren');
const chapterOf = (e) => (e.prompt.match(/Kapitel «?(Kapitel \d)/) || [])[1];

function registerConsolidation() {
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'), {
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist', beschreibung: 'Hauptfigur',
      sozialschicht: 'mitte', praesenz: 'zentral', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    }],
  });
  ctx.mockAi.on((e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'), { orte: [] });
  ctx.mockAi.on((e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    { zusammenfassung: 'Stimmig.', probleme: [] });
}

async function runJob(bookId) {
  const jobId = ctx.shared.createJob('komplett-analyse', bookId, USER, 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () => ctx.komplett.runKomplettAnalyseJob(jobId, bookId, 'Buch', USER, 'claude'));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
}

test('Multi-Pass mit Gap-Pass: Kapiteltext im System, Gap-Call teilt den Präfix des Basis-Calls', async () => {
  const BOOK_ID = 71;
  seedBook(BOOK_ID);
  require('../../lib/app-settings').set('ai.komplett.completeness_passes', 1);
  ctx.mockAi.on(isGap, { figuren: [], orte: [], songs: [], fakten: [], szenen: [], assignments: [] });
  ctx.mockAi.on(isP1, (e) => extraktion(chapterOf(e) || 'Kapitel 1'));
  registerConsolidation();

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.passMode, 'multi');

  const base = ctx.mockAi.log.filter(e => isP1(e) && !isGap(e));
  const gaps = ctx.mockAi.log.filter(isGap);
  assert.equal(base.length, 3);
  assert.equal(gaps.length, 3);
  for (const b of base) {
    const ch = chapterOf(b);
    assert.ok(b.system.startsWith(`Buch: «Buch»\n\nKapitel «${ch}»`), `Basis-Call ${ch}: Kapiteltext vorne im System`);
    assert.ok(b.prompt.includes('Der Kapiteltext steht im System-Prompt oben'));
    assert.ok(!b.prompt.includes('Anna ging weiter'), 'Kapiteltext NICHT zusätzlich im User-Turn');
    const g = gaps.find(x => chapterOf(x) === ch);
    assert.ok(g, `Gap-Call für ${ch}`);
    assert.equal(g.system, b.system, `Gap-Call ${ch}: byte-gleiches System → Cache-Read`);
  }
});

test('Multi-Pass ohne Gap-Pass: Kapiteltext bleibt im User-Turn', async () => {
  const BOOK_ID = 72;
  seedBook(BOOK_ID);
  ctx.mockAi.on(isP1, (e) => extraktion(chapterOf(e) || 'Kapitel 1'));
  registerConsolidation();

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  const base = ctx.mockAi.log.filter(isP1);
  assert.equal(base.length, 3);
  for (const b of base) {
    assert.ok(!b.system.startsWith('Buch: «'), 'kein Kapiteltext-Block im System');
    assert.ok(b.prompt.includes('Anna ging weiter'), 'Kapiteltext im User-Turn');
  }
});

test('Multi-Pass: truncierter Chunk wird halbiert extrahiert statt verworfen', async () => {
  const BOOK_ID = 73;
  seedBook(BOOK_ID);
  // Kapitel 2 am Stück → Truncation; jede Hälfte (eine Seite) passt.
  ctx.mockAi.on(
    (e) => isP1(e) && chapterOf(e) === 'Kapitel 2' && e.prompt.includes('Seite 2a') && e.prompt.includes('Seite 2b'),
    { __raw: { text: '{"figuren":[', truncated: true } },
  );
  ctx.mockAi.on(isP1, (e) => extraktion(chapterOf(e) || 'Kapitel 1'));
  registerConsolidation();

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  const ch2 = ctx.mockAi.log.filter(e => isP1(e) && chapterOf(e) === 'Kapitel 2');
  assert.equal(ch2.length, 3, 'ein truncierter Ganz-Call + zwei Hälften');
  assert.ok(ch2[1].prompt.includes('Seite 2a') && !ch2[1].prompt.includes('Seite 2b'));
  assert.ok(ch2[2].prompt.includes('Seite 2b') && !ch2[2].prompt.includes('Seite 2a'));
  assert.ok(!(job.result.warnings || []).some(w => w.key === 'job.warn.chunksTruncated'),
    'kein Truncation-Teilfehler mehr: das Kapitel trägt bei');
  const cached = ctx.dbSchema.db.prepare(
    'SELECT COUNT(*) AS n FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?'
  ).get(BOOK_ID, USER).n;
  assert.equal(cached, 3, 'auch das halbierte Kapitel ist gecacht → kein erneuter Truncation-Call im Folgelauf');
});

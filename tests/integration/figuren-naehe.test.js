'use strict';
// Integration: Job `figuren-naehe` (routes/jobs/figuren-naehe.js) mit Mock-AI, und
// der Erhalt der Nähe über den Schreibpfad der Komplettanalyse.
// Gegenstand: der Job schreibt nur `naehe`, nur an Beziehungen ohne Wert (ausser
// `alle`), klemmt KI-Werte auf −2 … +2 und übergeht unbekannte Schlüssel; ein
// Analyse-Neulauf ohne Nähe-Wert löscht eine bekannte Nähe nicht.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });
test.beforeEach(() => { ctx.mockAi.reset(); ctx.dbSeed.reset(); });

const USER = 'tester@test.dev';

function runJob(bookId, opts = {}) {
  const { runFigurenNaeheJob } = require('../../routes/jobs/figuren-naehe');
  const jobId = ctx.shared.createJob('figuren-naehe', bookId, USER, 'job.label.figurenNaehe');
  ctx.shared.enqueueJob(jobId, () => runFigurenNaeheJob(jobId, bookId, USER, opts));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

const FIGUREN = () => [
  { id: 'f_stefan', name: 'Stefan', typ: 'hauptfigur', beziehungen: [
    { figur_id: 'f_renate', typ: 'ehepartner', beschreibung: 'Versteinerte Ehe, er ignoriert sie.' },
    { figur_id: 'f_oliver', typ: 'freund', beschreibung: 'Einzige Bezugsperson.', naehe: 2 },
  ] },
  { id: 'f_renate', name: 'Renate', typ: 'hauptfigur', beziehungen: [
    { figur_id: 'f_gisela', typ: 'andere', beschreibung: 'Schwiegermutter und Stütze.' },
  ] },
  { id: 'f_oliver', name: 'Oliver', typ: 'nebenfigur' },
  { id: 'f_gisela', name: 'Gisela', typ: 'nebenfigur' },
];

function seed(BOOK_ID) {
  ctx.dbSeed.setBook({
    chapters: [{ id: BOOK_ID * 10 + 1, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: BOOK_ID * 100 + 1, book_id: BOOK_ID, chapter_id: BOOK_ID * 10 + 1, name: 'S 1', updated_at: '' }],
    pageBodies: { [BOOK_ID * 100 + 1]: '<p>Text.</p>' },
  });
  ctx.dbSchema.saveFigurenToDb(BOOK_ID, FIGUREN(), USER, null);
}

const naeheByPair = (BOOK_ID) => Object.fromEntries(ctx.dbSchema.db.prepare(`
  SELECT ff.fig_id AS a, ft.fig_id AS b, r.naehe FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id JOIN figures ft ON ft.id = r.to_fig_id
   WHERE r.book_id = ?`).all(BOOK_ID).map(r => [`${r.a}>${r.b}`, r.naehe]));

test('schätzt nur offene Beziehungen, klemmt Werte, übergeht fremde Schlüssel', async () => {
  const BOOK_ID = 980;
  seed(BOOK_ID);
  let prompt = '';
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('bewertungen'),
    (e) => {
      prompt = e.prompt || e.userPrompt || JSON.stringify(e);
      // Reihenfolge = ORDER BY r.id: Stefan→Renate (r1), Renate→Gisela (r2).
      return { bewertungen: [{ key: 'r1', naehe: -5 }, { key: 'r2', naehe: 2 }, { key: 'r9', naehe: 1 }] };
    },
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.beziehungen, 2, 'Stefan→Oliver hat schon eine Nähe');
  assert.equal(job.result.geschrieben, 2);
  assert.match(prompt, /Versteinerte Ehe/);
  assert.doesNotMatch(prompt, /Einzige Bezugsperson/);
  assert.deepEqual(naeheByPair(BOOK_ID), {
    'f_stefan>f_renate': -2, 'f_stefan>f_oliver': 2, 'f_renate>f_gisela': 2,
  });
});

test('nichts offen: Fehler-Key statt leerem Lauf; `alle` schätzt neu', async () => {
  const BOOK_ID = 981;
  seed(BOOK_ID);
  ctx.mockAi.on((e) => e.schemaKeys.includes('bewertungen'),
    () => ({ bewertungen: [{ key: 'r1', naehe: -1 }, { key: 'r2', naehe: 1 }, { key: 'r3', naehe: 1 }] }));
  assert.equal((await runJob(BOOK_ID)).status, 'done');
  const leer = await runJob(BOOK_ID);
  assert.equal(leer.status, 'error');
  assert.equal(leer.error, 'job.error.naeheNothingOpen');
  const alle = await runJob(BOOK_ID, { alle: true });
  assert.equal(alle.status, 'done');
  assert.equal(alle.result.beziehungen, 3);
});

test('Analyse-Neulauf ohne Nähe behält die bekannte Nähe; ein neuer Wert ersetzt sie', () => {
  const BOOK_ID = 982;
  seed(BOOK_ID);
  ctx.dbSchema.db.prepare('UPDATE figure_relations SET naehe = -1 WHERE book_id = ?').run(BOOK_ID);
  const ohne = FIGUREN().map(f => ({ ...f, beziehungen: (f.beziehungen || []).map(({ naehe, ...bz }) => bz) }));
  ctx.dbSchema.saveFigurenToDb(BOOK_ID, ohne, USER, null, { reconcile: true });
  assert.deepEqual(Object.values(naeheByPair(BOOK_ID)), [-1, -1, -1]);
  const neu = FIGUREN();
  neu[0].beziehungen[0].naehe = -2;
  ctx.dbSchema.saveFigurenToDb(BOOK_ID, neu, USER, null, { reconcile: true });
  assert.equal(naeheByPair(BOOK_ID)['f_stefan>f_renate'], -2);
});

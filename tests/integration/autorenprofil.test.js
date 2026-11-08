'use strict';
// Integration: Autorenprofil-Deutung (routes/jobs/autorenprofil.js) gegen Mock-AI.
//
// Der Job ist der einzige ohne Buchbezug. Geprueft wird genau das, was die
// Unit-Tests nicht sehen koennen: dass er die BUCH-Stilprofile und die Messung
// in den Prompt bekommt (und keinen Buchtext), dass er das Ergebnis unter dem
// KONTO ablegt, und dass er eine Entwicklungs-Behauptung verwirft, die bei nur
// einem Buch per Konstruktion unbelegt waere.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
const AUTOR = 'autor@integration.test';

test.before(() => {
  ctx = bootstrap();
  const { db } = require('../../db/connection');
  require('../../db/app-users').createUser({ email: AUTOR, displayName: 'Autor' });

  // Zwei eigene Buecher mit Lexikon-Zeile und Seitenstatistik.
  const mkBook = (id, name, created, stilprofil) => {
    db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)')
      .run(id, name, created, created, AUTOR);
    db.prepare(`INSERT INTO book_lexicon (book_id, tokens, pages, content_sig, mattr, mattr_window, mtld,
                hapax_ratio, yule_k, heaps_beta, lex_density) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, 50000, 10, `sig-${id}`, 0.51, 1000, 150, 0.58, 47, 0.78, 0.6);
    db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?,?,?)').run(id * 10, id, 'S1');
    db.prepare(`INSERT INTO page_stats (page_id, book_id, words, chars, sentences, dialog_chars,
                adverb_count, passive_count, filler_count, lix, flesch_de) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id * 10, id, 1000, 6000, 100, 1200, 20, 5, 10, 40, 60);
    // `book_settings.updated_at` ist NOT NULL ohne Default — explizit setzen.
    db.prepare('INSERT INTO book_settings (book_id, stilprofil, updated_at) VALUES (?,?,?)')
      .run(id, stilprofil, created);
  };
  mkBook(7001, 'Erstling', '2020-01-01T00:00:00Z', 'Kurze Saetze, wenig Dialog.');
  mkBook(7002, 'Zweitwerk', '2022-01-01T00:00:00Z', 'Kurze Saetze, viel Dialog.');
});
test.after(() => { ctx.cleanup(); });
test.beforeEach(() => { ctx.mockAi.reset(); });

const ANTWORT = {
  autorenprofil: 'Knappe, parataktische Saetze ueber beide Buecher hinweg.',
  konstanten: [{ aspekt: 'Satzbau', beleg: 'Satzlaenge bleibt bei 10' }],
  entwicklung: [{ aspekt: 'Dialog', richtung: 'nimmt zu', beleg: 'Stilprofile beider Buecher' }],
};

test('Lauf verdichtet Stilprofile + Messung und legt das Ergebnis am Konto ab', async () => {
  ctx.mockAi.on(() => true, ANTWORT);

  const jobId = ctx.shared.createJob('autorenprofil', 0, AUTOR, 'job.label.autorenprofil', {}, AUTOR);
  ctx.shared.enqueueJob(jobId, () => ctx.autorenprofil.runAutorenprofilJob(jobId, AUTOR));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', job.error || '');

  // Der Prompt traegt beide Stilprofile UND die Messung — aber keinen Buchtext.
  const call = ctx.mockAi.log[0];
  assert.ok(call, 'es gab genau einen KI-Call');
  assert.equal(ctx.mockAi.log.length, 1, 'ein Call, nicht einer pro Buch');
  assert.match(call.prompt, /Kurze Saetze, wenig Dialog\./);
  assert.match(call.prompt, /Kurze Saetze, viel Dialog\./);
  assert.match(call.prompt, /Erstling/);
  assert.match(call.prompt, /Satzlaenge/);

  // Persistiert am Konto, nicht an einem Buch.
  const { getAuthorProfileRow, getAuthorProfile } = require('../../db/author-profile');
  const row = getAuthorProfileRow(AUTOR);
  assert.equal(row.profil_text, ANTWORT.autorenprofil);
  assert.equal(row.konstanten.length, 1);
  assert.equal(row.entwicklung.length, 1);
  assert.equal(row.edited, false);
  // Die Basis-Signatur passt zum aktuellen Messstand ⇒ nicht veraltet.
  assert.equal(getAuthorProfile(AUTOR).profileStale, false);
});

test('Nur ein Buch: eine behauptete Entwicklung wird serverseitig verworfen', async () => {
  const { db } = require('../../db/connection');
  // Zweites Buch aus der Messung nehmen (zu kurz) — es bleibt EIN Vergleichspunkt.
  db.prepare('UPDATE book_lexicon SET tokens = 100 WHERE book_id = ?').run(7002);
  ctx.mockAi.on(() => true, ANTWORT); // liefert trotzdem eine Entwicklung

  const jobId = ctx.shared.createJob('autorenprofil', 0, AUTOR, 'job.label.autorenprofil', {}, AUTOR);
  ctx.shared.enqueueJob(jobId, () => ctx.autorenprofil.runAutorenprofilJob(jobId, AUTOR));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', job.error || '');

  // Prompt verlangt das leere Array — und der Server erzwingt es zusaetzlich.
  assert.match(ctx.mockAi.log[0].prompt, /LEERES Array/);
  assert.deepEqual(job.result.entwicklung, []);
  assert.deepEqual(require('../../db/author-profile').getAuthorProfileRow(AUTOR).entwicklung, []);
  // Die Konstanten bleiben — sie brauchen keinen zweiten Vergleichspunkt.
  assert.equal(job.result.konstanten.length, 1);

  db.prepare('UPDATE book_lexicon SET tokens = 50000 WHERE book_id = ?').run(7002);
});


test('Zwei Sprachen, je ein Buch: Entwicklung verworfen, Messung je Sprache im Prompt', async () => {
  const { db } = require('../../db/connection');
  db.prepare("UPDATE book_settings SET language = 'en' WHERE book_id = ?").run(7002);
  ctx.mockAi.on(() => true, ANTWORT); // liefert trotzdem eine Entwicklung

  const jobId = ctx.shared.createJob('autorenprofil', 0, AUTOR, 'job.label.autorenprofil', {}, AUTOR);
  ctx.shared.enqueueJob(jobId, () => ctx.autorenprofil.runAutorenprofilJob(jobId, AUTOR));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done', job.error || '');

  const prompt = ctx.mockAi.log[0].prompt;
  assert.match(prompt, /Sprachen: (Deutsch: Erstling; Englisch: Zweitwerk|Englisch: Zweitwerk; Deutsch: Erstling)\./);
  assert.match(prompt, /== Ueber alle Sprachen ==/);
  assert.match(prompt, /Sprachunterschied, keine Entwicklung/);
  // Ein deutsches und ein englisches Buch sind kein Vergleichspaar: der Server verwirft.
  assert.deepEqual(job.result.entwicklung, []);
  assert.equal(job.result.konstanten.length, 1);

  db.prepare("UPDATE book_settings SET language = 'de' WHERE book_id = ?").run(7002);
});
test('Leere KI-Antwort wird zum Fehler, nicht zu einem leeren Profil', async () => {
  ctx.mockAi.on(() => true, { autorenprofil: '   ', konstanten: [], entwicklung: [] });
  const jobId = ctx.shared.createJob('autorenprofil', 0, AUTOR, 'job.label.autorenprofil', {}, AUTOR);
  ctx.shared.enqueueJob(jobId, () => ctx.autorenprofil.runAutorenprofilJob(jobId, AUTOR));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'error');
});

test('Konto ohne gemessene Buecher: sauberer Leerlauf statt Fehler', async () => {
  require('../../db/app-users').createUser({ email: 'leer@integration.test', displayName: 'Leer' });
  const jobId = ctx.shared.createJob('autorenprofil', 0, 'leer@integration.test', 'job.label.autorenprofil', {}, 'leer@integration.test');
  ctx.shared.enqueueJob(jobId, () => ctx.autorenprofil.runAutorenprofilJob(jobId, 'leer@integration.test'));
  const job = await waitForJob(ctx.shared, jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.result.empty, true);
  assert.equal(ctx.mockAi.log.length, 0, 'ohne Messung gar kein KI-Call');
});

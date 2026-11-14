'use strict';
// Integration: Autorenprofil-Deutung (routes/jobs/autorenprofil.js) gegen Mock-AI.
//
// Der Job ist der einzige ohne Buchbezug. Geprueft wird genau das, was die
// Unit-Tests nicht sehen koennen: dass er die BUCH-Stilprofile und die Messung
// in den Prompt bekommt (und keinen Buchtext), dass er den geltenden Text nicht
// anfasst, sein Ergebnis aber als offenen Vorschlag ablegt (überlebt ein Ende,
// das die Karte nicht sah), dass das übernommene Ergebnis unter dem KONTO landet
// und Übernehmen/Verwerfen den offenen Vorschlag erledigen, und dass er eine Entwicklungs-Behauptung verwirft, die bei nur
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

  // Der Lauf fasst den geltenden Text NICHT an — sein Ergebnis ist ein Vorschlag
  // mit der Basis des Laufs; erst «Übernehmen» (PUT /me/author-profile mit `run`)
  // legt ihn am Konto ab. Bis dahin steht er als offener Vorschlag bereit.
  const { getAuthorProfileRow, getAuthorProfile } = require('../../db/author-profile');
  const { getProposal } = require('../../db/ai-proposals');
  assert.equal(getAuthorProfileRow(AUTOR), null);
  const offen = getProposal('autorenprofil', AUTOR, null);
  assert.equal(offen?.payload?.profilText, ANTWORT.autorenprofil, 'offener Vorschlag liegt bereit');
  assert.equal(offen.payload.basisSig, job.result.basisSig);
  assert.equal(job.result.profilText, ANTWORT.autorenprofil);
  assert.ok(Array.isArray(job.result.basis) && job.result.basis.length === 2);
  assert.equal(job.result.basisSig, getAuthorProfile(AUTOR).basisSig);

  // Übernehmen über die Route: am Konto, nicht an einem Buch, als Lauf (edited = 0).
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: AUTOR } }; next(); });
  app.use('/me/author-profile', require('../../routes/author-profile'));
  app.use('/ai-proposals', require('../../routes/ai-proposals'));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  try {
    const g = await (await fetch(`${base()}/ai-proposals/autorenprofil`)).json();
    assert.equal(g.proposal?.payload?.profilText, ANTWORT.autorenprofil, 'GET liefert den offenen Vorschlag');
    const r = await fetch(`${base()}/me/author-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: {
        profil_text: job.result.profilText, konstanten: job.result.konstanten,
        entwicklung: job.result.entwicklung, basis: job.result.basis, basis_sig: job.result.basisSig,
      } }),
    });
    assert.equal(r.status, 200);
    assert.equal(getProposal('autorenprofil', AUTOR, null), null, 'Übernehmen erledigt den Vorschlag');

    // Verwerfen: ein neuer offener Vorschlag verschwindet per DELETE.
    require('../../db/ai-proposals').saveProposal('autorenprofil', AUTOR, null, { profilText: 'x' });
    const d = await fetch(`${base()}/ai-proposals/autorenprofil`, { method: 'DELETE' });
    assert.equal(d.status, 200);
    assert.equal(getProposal('autorenprofil', AUTOR, null), null, 'Verwerfen erledigt den Vorschlag');
  } finally { await new Promise((resolve) => server.close(resolve)); }
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

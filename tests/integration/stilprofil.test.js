'use strict';
// Integration: Stilprofil-Destillat (routes/jobs/stilprofil.js) gegen Mock-AI.
//
// Geprüft wird, was die Unit-Tests (stilprofil-injection) nicht sehen:
//   * Der Lauf liefert das Profil als Job-Ergebnis und schreibt NICHTS nach
//     `book_settings.stilprofil` — das Ergebnis ist ein Vorschlag, gespeichert
//     wird erst über den Speichern-Knopf der Bucheinstellungen. Bis dahin liegt
//     es als offener Vorschlag bereit (/ai-proposals/stilprofil), nur für den,
//     der den Lauf gestartet hat, und nur mit Editor-Rolle.
//   * Ein Buch über dem Single-Pass-Budget wird über das ganze Buch gestreut
//     gesampelt (Anfang, Mitte, Ende), nicht vorne abgeschnitten.
//   * Leeres Buch → `{ empty: true }` ohne KI-Call; fehlendes Pflichtfeld und
//     abgeschnittene Antwort → Fehler statt leerem Profil.
//   * Die Route verlangt die Editor-Rolle.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx, db, server, baseUrl, sessionUser;
const USER = 'autor@test.dev';
const VIEWER = 'mitarbeit@test.dev';
const BOOK = 9601;
const NOW = '2026-01-01T00:00:00.000Z';
const PROFIL = 'Knappe Hauptsätze, Präsens, kaum Adjektive.';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/jobs', ctx.stilprofil.stilprofilRouter);
    app.use('/ai-proposals', require('../../routes/ai-proposals'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    server.on('error', reject);
  });
}

async function post(path, body, method = 'POST') {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = ctx.dbSchema.db;
  await startServer();
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });
test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
  sessionUser = USER;
  db.prepare('DELETE FROM book_settings').run();
  db.prepare('DELETE FROM book_access').run();
  db.prepare('DELETE FROM ai_proposals').run();
});

/** Buch mit `n` Abschnitten à `chars` Zeichen; jeder trägt die Marke ABSCHNITT-<i>. */
function seedBook(n, chars = 400) {
  const pages = [], pageBodies = {};
  for (let i = 0; i < n; i++) {
    const id = 96100 + i;
    pages.push({ id, book_id: BOOK, chapter_id: 96010, name: `A${i}`, position: i });
    const filler = 'Der Regen fiel. Sie ging weiter. '.repeat(Math.ceil(chars / 33)).slice(0, chars);
    pageBodies[id] = `<p>ABSCHNITT-${String(i).padStart(2, '0')} ${filler}</p>`;
  }
  ctx.dbSeed.setBook({ chapters: [{ id: 96010, book_id: BOOK, name: 'Kapitel 1' }], pages, pageBodies });
  require('../../db/book-access').grantAccess(BOOK, USER, 'editor', USER);
}

function runJob() {
  const jobId = ctx.shared.createJob('stilprofil', BOOK, USER, 'job.label.stilprofil');
  ctx.shared.enqueueJob(jobId, () => ctx.stilprofil.runStilprofilJob(jobId, BOOK, USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

test('Lauf liefert das Profil als Vorschlag und persistiert nichts', async () => {
  seedBook(3);
  db.prepare('INSERT INTO book_settings (book_id, stilprofil, updated_at) VALUES (?, ?, ?)').run(BOOK, 'Altes Profil', NOW);
  ctx.mockAi.on({ schemaHas: 'stilprofil' }, { stilprofil: `  ${PROFIL}  ` });

  const job = await runJob();
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.stilprofil, PROFIL, 'getrimmt');
  assert.equal(ctx.mockAi.log.length, 1, 'genau ein KI-Call');
  assert.match(ctx.mockAi.log[0].prompt, /ABSCHNITT-00/);
  assert.match(ctx.mockAi.log[0].prompt, /ABSCHNITT-02/);
  assert.equal(
    db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = ?').get(BOOK).stilprofil,
    'Altes Profil', 'book_settings.stilprofil bleibt unverändert',
  );
  const { getProposal } = require('../../db/ai-proposals');
  assert.equal(getProposal('stilprofil', USER, BOOK)?.payload?.stilprofil, PROFIL, 'offener Vorschlag liegt bereit');
});

test('offener Vorschlag: nur der Starter mit Editor-Rolle sieht ihn, DELETE erledigt ihn', async () => {
  seedBook(1);
  require('../../db/book-access').grantAccess(BOOK, VIEWER, 'viewer', USER);
  require('../../db/ai-proposals').saveProposal('stilprofil', USER, BOOK, { stilprofil: PROFIL });

  const got = await post(`/ai-proposals/stilprofil?book_id=${BOOK}`, null, 'GET');
  assert.equal(got.status, 200);
  assert.equal(got.json.proposal.payload.stilprofil, PROFIL);

  sessionUser = VIEWER;
  assert.equal((await post(`/ai-proposals/stilprofil?book_id=${BOOK}`, null, 'GET')).status, 403);
  assert.equal((await post(`/ai-proposals/stilprofil?book_id=${BOOK}`, null, 'DELETE')).status, 403);

  sessionUser = USER;
  assert.equal((await post(`/ai-proposals/stilprofil?book_id=${BOOK}`, null, 'DELETE')).status, 200);
  const after = await post(`/ai-proposals/stilprofil?book_id=${BOOK}`, null, 'GET');
  assert.equal(after.json.proposal, null);
  assert.equal((await post('/ai-proposals/quatsch', null, 'GET')).status, 404);
});

test('Buch über dem Budget: Leseprobe gestreut über Anfang, Mitte und Ende', async () => {
  // 40 × 6000 Zeichen = 240K — deutlich über dem Single-Pass-Budget des Test-Setups.
  seedBook(40, 6000);
  ctx.mockAi.on({ schemaHas: 'stilprofil' }, { stilprofil: PROFIL });

  const job = await runJob();
  assert.equal(job.status, 'done', job.error || '');
  const prompt = ctx.mockAi.log[0].prompt;
  const seen = [...prompt.matchAll(/ABSCHNITT-(\d\d)/g)].map(m => Number(m[1]));
  const uniq = [...new Set(seen)];
  assert.ok(uniq.length < 40, `gesampelt, nicht alles (${uniq.length}/40)`);
  assert.ok(uniq.some(i => i < 8), 'Probe vom Anfang');
  assert.ok(uniq.some(i => i >= 16 && i < 24), 'Probe aus der Mitte');
  assert.ok(uniq.some(i => i >= 32), 'Probe vom Ende');
  assert.ok(prompt.length < 240000, 'Prompt unter dem Buchumfang');
});

test('leeres Buch → empty ohne KI-Call', async () => {
  ctx.dbSeed.setBook({ books: [{ id: BOOK, name: 'Leer' }] });
  const job = await runJob();
  assert.equal(job.status, 'done', job.error || '');
  assert.deepEqual(job.result, { empty: true });
  assert.equal(ctx.mockAi.log.length, 0);
});

test('Antwort ohne Profiltext → Fehler statt leerem Vorschlag', async () => {
  seedBook(2);
  ctx.mockAi.on({ schemaHas: 'stilprofil' }, { stilprofil: '   ' });
  const job = await runJob();
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.stilprofilMissing');
});

test('abgeschnittene Antwort → Fehler, kein Teil-Profil', async () => {
  seedBook(2);
  ctx.mockAi.on({ schemaHas: 'stilprofil' }, { __raw: { text: '{"stilprofil": "Knappe Haupt', truncated: true } });
  const job = await runJob();
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.aiTruncated');
  assert.ok(!job.result, 'kein Teil-Ergebnis');
});

test('Route: Editor startet den Lauf, Viewer bekommt 403', async () => {
  seedBook(2);
  require('../../db/book-access').grantAccess(BOOK, VIEWER, 'viewer', USER);
  ctx.mockAi.on({ schemaHas: 'stilprofil' }, { stilprofil: PROFIL });

  sessionUser = VIEWER;
  const denied = await post('/jobs/stilprofil', { book_id: BOOK });
  assert.equal(denied.status, 403);

  sessionUser = USER;
  const ok = await post('/jobs/stilprofil', { book_id: BOOK });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.jobId);
  const job = await waitForJob(ctx.shared, ok.json.jobId, { timeoutMs: 15000 });
  assert.equal(job.status, 'done', job.error || '');
});

'use strict';
// Werkstand eines nicht abgeschlossenen Buchs, End-to-End durch die echten Jobs:
// was kommt beim Modell an, wenn jemand einen Abschnitt pro Kapitel schreibt
// und das nächste Kapitel schon als leere Hülle angelegt hat?
//   · Lektorat: Nachbar aus dem vorherigen Kapitel (Kapitelwechsel), und hinter
//     dem Abschnitt folgt kein Text mehr → Schreibstelle.
//   · Kapitelbewertung: das Kapitel vor der leeren Hülle ist die Schreibfront,
//     obwohl es im Baum nicht das letzte ist.
//   · Buchbewertung: Werkstand-Block mit der leeren Hülle.
// Ein als abgeschlossen markiertes Buch bekommt nichts davon.

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
const PROSA = (s) => '<p>' + `${s} `.repeat(20) + '</p>';

function seedBuch(bookId) {
  ctx.dbSeed.setBook({
    chapters: [
      { id: bookId * 10 + 1, book_id: bookId, name: 'Ankunft' },
      { id: bookId * 10 + 2, book_id: bookId, name: 'Der Wald' },
      { id: bookId * 10 + 3, book_id: bookId, name: 'Rückkehr' },
    ],
    pages: [
      { id: bookId * 100 + 1, book_id: bookId, chapter_id: bookId * 10 + 1, name: 'A', position: 0 },
      { id: bookId * 100 + 2, book_id: bookId, chapter_id: bookId * 10 + 2, name: 'B', position: 0 },
      { id: bookId * 100 + 3, book_id: bookId, chapter_id: bookId * 10 + 3, name: 'C', position: 0 },
    ],
    pageBodies: {
      [bookId * 100 + 1]: PROSA('Anna kam am Bahnhof an.'),
      [bookId * 100 + 2]: PROSA('Im Wald war es still, und dann'),
      [bookId * 100 + 3]: '<p></p>',
    },
  });
}

function markFinished(bookId) {
  ctx.dbSchema.db.prepare('INSERT INTO book_settings (book_id, is_finished, updated_at) VALUES (?, 1, ?)')
    .run(bookId, '2026-10-10T00:00:00Z');
}

const lektoratResponse = { fehler: [], szenen: [], stilanalyse: 'ok', fazit: 'ok' };
const chapterReviewResponse = {
  gesamtnote: 4, gesamtnote_begruendung: 'x', zusammenfassung: 'x',
  dramaturgie: 'x', pacing: 'x', kohaerenz: 'x', perspektive: 'x', figuren: 'x',
  staerken: [], schwaechen: [], empfehlungen: [], fazit: 'x',
};

async function runLektorat(bookId, pageId) {
  ctx.mockAi.on((e) => e.schemaKeys.includes('fehler'), lektoratResponse);
  const id = ctx.shared.createJob('check', bookId, USER, 'job.label.checkPage', null, pageId);
  ctx.shared.enqueueJob(id, () => ctx.lektorat.runCheckJob(id, pageId, bookId, USER));
  const job = await waitForJob(ctx.shared, id);
  assert.equal(job.status, 'done', job.error || '');
  return ctx.mockAi.log.map(e => e.prompt).join('\n');
}

async function runKapitel(bookId, chapterId, name) {
  ctx.mockAi.on((e) => e.schemaKeys.includes('gesamtnote') && e.schemaKeys.includes('dramaturgie'), chapterReviewResponse);
  const id = ctx.shared.createJob('chapter-review', bookId, USER, 'job.label.chapterReview', null, chapterId);
  ctx.shared.enqueueJob(id, () => ctx.kapitel.runChapterReviewJob(id, bookId, chapterId, name, 'Buch', USER));
  const job = await waitForJob(ctx.shared, id);
  assert.equal(job.status, 'done', job.error || '');
  return ctx.mockAi.log.at(-1).prompt;
}

test('Lektorat: Kapitelwechsel-Nachbar und Schreibstelle im unfertigen Buch', async () => {
  seedBuch(610);
  const p = await runLektorat(610, 61002);
  assert.match(p, /Letzter Absatz des vorherigen Kapitels «Ankunft» \(Kapitelwechsel\)/);
  assert.match(p, /Anna kam am Bahnhof an\./, 'Auszug aus dem Vorkapitel fehlt');
  assert.ok(!p.includes('<naechste_seite'), 'leere Hülle liefert keinen Auszug');
  assert.match(p, /SCHREIBSTELLE/);
});

test('Lektorat: im abgeschlossenen Buch keine Schreibstelle, Kapitelwechsel bleibt', async () => {
  seedBuch(611);
  markFinished(611);
  const p = await runLektorat(611, 61102);
  assert.match(p, /\(Kapitelwechsel\)/);
  assert.ok(!p.includes('SCHREIBSTELLE'));
});

test('Kapitelbewertung: Kapitel vor leerer Hülle ist die Schreibfront', async () => {
  seedBuch(612);
  const front = await runKapitel(612, 6122, 'Der Wald');
  assert.match(front, /Kapitel 2 von bisher 3\./);
  assert.match(front, /KEIN Schlusskapitel/);
  assert.match(front, /1 Kapitel angelegt, aber noch ungeschrieben: «Rückkehr»/);
  assert.ok(!front.includes('Nächstes Kapitel: «Rückkehr»'), 'Hülle steht nicht als Nachbar da');

  const frueher = await runKapitel(612, 6121, 'Ankunft');
  assert.ok(!frueher.includes('KEIN Schlusskapitel'), 'danach folgt noch Text');
});

test('Kapitelbewertung: abgeschlossenes Buch ohne Werkstand', async () => {
  seedBuch(613);
  markFinished(613);
  const p = await runKapitel(613, 6132, 'Der Wald');
  assert.match(p, /Kapitel 2 von 3\./);
  assert.ok(!p.includes('KEIN Schlusskapitel'));
});

test('Buchbewertung: Werkstand nennt die leere Hülle', async () => {
  seedBuch(614);
  ctx.mockAi.on((e) => e.schemaKeys.includes('gesamtnote'), {
    gesamtnote: 4, gesamtnote_begruendung: 'x', zusammenfassung: 'x',
    struktur: 'x', stil: 'x', plot: 'x', figuren: 'x', dramaturgie: 'x', pacing: 'x', thema: 'x',
    staerken: [], schwaechen: [], empfehlungen: [], beispielzitate: [], fazit: 'x',
  });
  const id = ctx.shared.createJob('review', 614, USER, 'job.label.review');
  ctx.shared.enqueueJob(id, () => ctx.review.runReviewJob(id, 614, 'Buch', USER));
  const job = await waitForJob(ctx.shared, id);
  assert.equal(job.status, 'done', job.error || '');
  const p = ctx.mockAi.log.at(-1).prompt;
  assert.match(p, /WERKSTAND: IN ARBEIT/);
  assert.match(p, /ungeschrieben \(1 Kapitel nach dem bisherigen Text\): «Rückkehr»/);
});

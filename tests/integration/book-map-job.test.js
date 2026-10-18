'use strict';
// Integration: Buchlandkarte-Job (routes/jobs/book-map.js) gegen eine echte DB.
//
// Was die Unit-Tests der Mathematik nicht sehen: dass der Job Passagen samt
// Chunk-Index aus dem Index liest, die Matrix in Lesereihenfolge kodiert, die
// Pol-Kandidaten auf den eigenen User einschränkt und einen fremden Pol nicht
// still verwendet, sondern mit lesbarem Fehler abbricht. Kein Embedding-
// Endpunkt: die Vektoren werden von Hand gesetzt, Freitext-Pole bleiben aussen vor.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

const ME = 'bm-autor@test.dev';
const OTHER = 'bm-fremd@test.dev';
const BOOK = 9501;
const NOW = '2026-01-01T00:00:00.000Z';
const MODEL = 'test-embed';
const DIM = 4;
const TEXT = 'Ein ausreichend langer Absatz, der über der Mindestlänge der Karte liegt.';
const PAGES = Array.from({ length: 10 }, (_, i) => 950101 + i);

// Abschnitte 0–4 um Richtung e0, 5–9 um e1; je zwei Passagen mit leichtem Versatz.
function vec(axis, i, k) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  v[2] = 0.15 * Math.sin(i + 1 + k);
  v[3] = 0.15 * Math.cos(2 * i + k);
  return v;
}

let ctx; let db; let job; let ids;

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const appSettings = require('../../lib/app-settings');
  appSettings.set('embed.enabled', true);
  appSettings.set('embed.host', 'http://embed.invalid');
  appSettings.set('embed.model', MODEL);
  appSettings.set('embed.dim', DIM);

  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Buch', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)');
  insChap.run(95011, BOOK, 'K1', 0, NOW);
  insChap.run(95012, BOOK, 'K2', 1, NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, ?, ?, '<p>x</p>')`);
  PAGES.forEach((id, i) => insPage.run(id, BOOK, `P${i + 1}`, i < 5 ? 95011 : 95012, i, NOW));

  const sc = require('../../db/semantic-chunks');
  PAGES.forEach((id, i) => {
    const axis = i < 5 ? 0 : 1;
    sc.replaceEntity('page', id, BOOK, MODEL, DIM, [0, 1].map(k => ({
      chunk_ix: k, content_hash: `h${k}`, vector: vec(axis, i, k), text: TEXT,
    })));
  });

  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, updated_at) VALUES (?, ?, ?, ?, ?)`);
  const insLoc = db.prepare(`INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)`);
  ids = {
    myFig: Number(insFig.run(BOOK, ME, 'fig_a', 'Anna', NOW).lastInsertRowid),
    otherFig: Number(insFig.run(BOOK, OTHER, 'fig_b', 'Bruno', NOW).lastInsertRowid),
    myLoc: Number(insLoc.run(BOOK, 'loc_k', 'Kontor', ME, NOW).lastInsertRowid),
  };
  const profile = (v) => [{ chunk_ix: 0, content_hash: 'p', vector: Float32Array.from(v), text: TEXT }];
  sc.replaceEntity('figure', ids.myFig, BOOK, MODEL, DIM, profile([1, 0, 0, 0]));
  sc.replaceEntity('figure', ids.otherFig, BOOK, MODEL, DIM, profile([0, 1, 0, 0]));
  sc.replaceEntity('location', ids.myLoc, BOOK, MODEL, DIM, profile([0, 1, 0, 0]));
  sc.markIndexed(BOOK, MODEL);

  job = require('../../routes/jobs/book-map');
});
test.after(() => { ctx.cleanup(); });

async function run(opts) {
  const jobId = ctx.shared.createJob('book-map', BOOK, ME, 'job.label.bookMap');
  ctx.shared.enqueueJob(jobId, () => job.runBookMapJob(jobId, BOOK, ME, { granularity: 'page', poles: null, ...opts }));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
}

test('Hauptrichtungen: Punkte je Abschnitt, drei Achsen, Matrix in Lesereihenfolge', async () => {
  const done = await run({});
  assert.equal(done.status, 'done', done.error || '');
  const r = done.result;
  assert.equal(r.projection.mode, 'pca');
  assert.equal(r.projection.points.length, 10);
  assert.equal(r.projection.axes.length, 3);
  assert.ok(r.projection.points.every(p => p.ix === null && p.c.length === 3));
  assert.equal(r.matrix.size, 10);
  assert.deepEqual(r.matrix.bins.map(b => b[0]), PAGES);
  assert.equal(Buffer.from(r.matrix.data, 'base64').length, (10 * 11) / 2);
  assert.ok(r.explainedVariance > 0.5, 'zwei Gruppen → erste Achse trägt viel');
  // Pol-Kandidaten: nur Figuren und Orte des eigenen Users.
  const names = r.poleCandidates.map(c => c.name).sort();
  assert.deepEqual(names, ['Anna', 'Kontor']);
});

test('Passagen: ein Punkt je Chunk, Sprungziel bleibt der Abschnitt', async () => {
  const done = await run({ granularity: 'chunk' });
  assert.equal(done.status, 'done', done.error || '');
  const pts = done.result.projection.points;
  assert.equal(pts.length, 20);
  assert.deepEqual(pts.slice(0, 2).map(p => [p.id, p.ix]), [[PAGES[0], 0], [PAGES[0], 1]]);
  // Matrix und Kapitel-Kennzahlen bleiben auf Abschnitts-Ebene.
  assert.equal(done.result.matrix.size, 10);
  assert.equal(done.result.pages.length, 10);
});

test('Eigene Pole: Figur gegen Ort, positiv heisst näher an der Figur', async () => {
  const done = await run({
    poles: { x: [{ kind: 'figure', id: ids.myFig }, { kind: 'location', id: ids.myLoc }], y: null },
  });
  assert.equal(done.status, 'done', done.error || '');
  const { projection } = done.result;
  assert.equal(projection.mode, 'poles');
  assert.deepEqual(projection.axes[0].poles, ['Anna', 'Kontor']);
  const xs = projection.points.map(p => p.c[0]);
  assert.ok(xs.slice(0, 5).every(v => v > 0), 'Abschnitte bei e0 liegen bei Anna');
  assert.ok(xs.slice(5).every(v => v < 0), 'Abschnitte bei e1 liegen beim Kontor');
  assert.equal(done.result.explainedVariance, null);
});

test('Fremde Figur als Pol → Abbruch mit lesbarem Fehler, kein stiller Ersatz', async () => {
  const done = await run({
    poles: { x: [{ kind: 'figure', id: ids.otherFig }, { kind: 'location', id: ids.myLoc }], y: null },
  });
  assert.equal(done.status, 'error');
  assert.equal(done.error, 'job.error.bookMapPoleMissing');
});

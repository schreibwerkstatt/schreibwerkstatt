'use strict';
// Integration: Manuskript-Import (routes/jobs/manuscript-import.js) gegen eine
// echte DB. Geprueft wird die Reihenfolge im Buch (book_order), nicht nur die
// Zerlegung: Kapitel- und Abschnittspositionen zaehlen in verschiedenen
// Buckets, eine Rekonstruktion daraus stellt ein Vorwort hinter Kapitel 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { bootstrap } = require('./_helpers/setup');

const OWNER = 'autor@test.dev';
let ctx, contentStore, shared, mi;

test.before(() => {
  ctx = bootstrap();
  contentStore = require('../../lib/content-store');
  shared = ctx.shared;
  mi = require('../../routes/jobs/manuscript-import');
});
test.after(() => ctx.cleanup());
test.beforeEach(() => ctx.dbSeed.reset());

async function makeOdt(body) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml',
    `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const h = (lvl, t) => `<text:h text:outline-level="${lvl}">${t}</text:h>`;
const p = (t) => `<text:p>${t}</text:p>`;

async function runImport(buffer, opts) {
  const jobId = shared.createJob('manuscript-import', 0, OWNER, 'job.label.manuscriptImport', {}, `t:${Math.random()}`);
  mi.manuscriptBuffers.put(jobId, { buffer, userEmail: OWNER, filename: 'buch.odt' });
  await mi.runManuscriptImportJob(jobId, { userEmail: OWNER, mode: 'new-book', bookName: 'Import', ...opts });
  return shared.jobs.get(jobId);
}

// Lesereihenfolge aus book_order, kompakt.
async function readingOrder(bookId) {
  const out = await contentStore.bookOutline(bookId, { session: { user: { email: OWNER } } });
  return out.map(n => `${n.type === 'chapter' ? 'K' : 'A'}${n.depth}:${n.name}`);
}

test('Reihenfolge: Vorwort vor Kapitel 1, Kapiteleinleitung vor dem Unterkapitel', async () => {
  const odt = await makeOdt([
    p('Vorwort-Text'),
    h(1, 'Teil A'), p('Intro A'),
    h(2, 'Kap A1'), p('Text A1'),
    h(1, 'Teil B'), p('Text B'),
  ].join(''));
  const job = await runImport(odt, { headingMap: { h1: 'chapter', h2: 'subchapter' } });
  assert.equal(job.status, 'done', job.error || '');
  assert.deepEqual(await readingOrder(job.result.bookId), [
    'A0:Abschnitt 1',
    'K1:Teil A', 'A1:Teil A',
    'K2:Kap A1', 'A2:Kap A1',
    'K1:Teil B', 'A1:Teil B',
  ]);
});

test('Abbruch zentral: completeJob nach cancelJob endet als «cancelled», nicht «done»', () => {
  const jobId = shared.createJob('manuscript-import', 0, OWNER, 'job.label.manuscriptImport', {}, `t:${Math.random()}`);
  shared.jobs.get(jobId).status = 'running';
  assert.equal(shared.cancelJob(jobId, OWNER), true);
  shared.completeJob(jobId, { ok: true });
  const job = shared.jobs.get(jobId);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.result == null, "kein Ergebnis");
});

test('Abbruch Manuskript-Import: Job «cancelled», das angelegte Buch ist wieder weg', async () => {
  const before = (await contentStore.listBooks({ session: { user: { email: OWNER } } })).length;
  const odt = await makeOdt([h(1, 'Teil A'), p('Text A'), h(1, 'Teil B'), p('Text B')].join(''));
  const jobId = shared.createJob('manuscript-import', 0, OWNER, 'job.label.manuscriptImport', {}, `t:${Math.random()}`);
  shared.jobs.get(jobId).status = 'running';
  shared.cancelJob(jobId, OWNER);   // Abbruch, bevor der Worker anlegt
  mi.manuscriptBuffers.put(jobId, { buffer: odt, userEmail: OWNER, filename: 'buch.odt' });
  await mi.runManuscriptImportJob(jobId, { userEmail: OWNER, mode: 'new-book', bookName: 'Abbruch' });
  assert.equal(shared.jobs.get(jobId).status, 'cancelled');
  const after = await contentStore.listBooks({ session: { user: { email: OWNER } } });
  assert.equal(after.length, before);
  assert.ok(!after.some(b => b.name === 'Abbruch'));
});

test('Import-Puffer: ein in der Warteschlange abgebrochener Job blockiert den naechsten Upload nicht', () => {
  const jobId = shared.createJob('manuscript-import', 0, OWNER, 'job.label.manuscriptImport', {}, `t:${Math.random()}`);
  mi.manuscriptBuffers.put(jobId, { buffer: Buffer.from('x'), userEmail: OWNER, filename: 'a.odt' });
  assert.equal(mi.manuscriptBuffers.admissionError(OWNER, 1), 'IMPORT_PENDING');
  shared.cancelJob(jobId, OWNER);   // queued → sofort terminal, Worker startet nie
  assert.equal(mi.manuscriptBuffers.admissionError(OWNER, 1), null);
  assert.equal(mi.manuscriptBuffers.has(jobId), false);
});

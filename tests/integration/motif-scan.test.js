'use strict';
// Integration: Motiv-Erkennung (Job motif-scan), Trigger-Pfad. Ohne Embedding-
// Backend (embed.* nicht konfiguriert → embed.isEnabled() false) läuft der Scan
// rein wörtlich über die FTS5-trigger_terms. Deterministisch, kein Mock-AI nötig.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx, motifsDb, motifScan, searchIndex, shared;
const BOOK = 990101;
const USER = 'test@example.com';

test.before(() => {
  ctx = bootstrap();
  motifsDb = require('../../db/motifs');
  motifScan = require('../../routes/jobs/motif-scan');
  searchIndex = require('../../lib/search');
  shared = ctx.shared;
});
test.after(() => { ctx.cleanup(); });

test('motif-scan (Trigger-Pfad): findet Fundstellen + Full-Replace', async () => {
  ctx.dbSeed.reset();
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Motiv-Integrationsbuch' }],
    chapters: [{ id: 5001, book_id: BOOK, name: 'Kapitel 1' }],
    pages: [
      { id: 6001, book_id: BOOK, chapter_id: 5001, name: 'Seite A' },
      { id: 6002, book_id: BOOK, chapter_id: 5001, name: 'Seite B' },
    ],
    pageBodies: {
      6001: '<p>Der Regen fiel unaufhörlich auf den Fluss.</p>',
      6002: '<p>Sonnenschein und trockene Wege, kein Wasser weit und breit.</p>',
    },
  });
  // FTS-Index für die Seiten aufbauen (der Trigger-Scan liest daraus).
  searchIndex.upsertPage(6001);
  searchIndex.upsertPage(6002);

  const motif = motifsDb.createMotif(BOOK, USER, {
    name: 'Wasser', beschreibung: 'Nässe, Fluss', triggerTerms: ['Regen', 'Fluss'],
  });

  const jobId = shared.createJob('motif-scan', BOOK, USER, 'job.label.motivScan', null, BOOK);
  await motifScan.runMotifScanJob(jobId, BOOK, USER);
  assert.equal(shared.jobs.get(jobId).status, 'done');

  const occ = motifsDb.listOccurrences(motif.id);
  // Nur Seite A trägt „Regen"/„Fluss" → genau eine Fundstelle (dedup pro Ort).
  assert.equal(occ.length, 1);
  assert.equal(occ[0].page_id, 6001);
  assert.equal(occ[0].source, 'trigger');
  assert.equal(occ[0].chapter_name, 'Kapitel 1');

  // Full-Replace: Trigger entfernen + erneut scannen → keine Fundstellen mehr.
  motifsDb.updateMotif(motif.id, { name: 'Wasser', triggerTerms: [] });
  const jobId2 = shared.createJob('motif-scan', BOOK, USER, 'job.label.motivScan', null, BOOK);
  await motifScan.runMotifScanJob(jobId2, BOOK, USER);
  assert.equal(motifsDb.listOccurrences(motif.id).length, 0);
});

test('motif-scan mit onlyMotifId: nur dieses Motiv wird neu geschrieben', async () => {
  ctx.dbSeed.reset();
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Motiv-Integrationsbuch' }],
    chapters: [{ id: 5001, book_id: BOOK, name: 'Kapitel 1' }],
    pages: [{ id: 6001, book_id: BOOK, chapter_id: 5001, name: 'Seite A' }],
    pageBodies: { 6001: '<p>Regen über dem Spiegel des Sees.</p>' },
  });
  searchIndex.upsertPage(6001);

  const wasser = motifsDb.createMotif(BOOK, USER, { name: 'Wasser', triggerTerms: ['Regen'] });
  const spiegel = motifsDb.createMotif(BOOK, USER, { name: 'Spiegel', triggerTerms: ['Spiegel'] });

  const jobId = shared.createJob('motif-scan', BOOK, USER, 'job.label.motivScan', null, `${BOOK}:m${wasser.id}`);
  await motifScan.runMotifScanJob(jobId, BOOK, USER, wasser.id);
  assert.equal(shared.jobs.get(jobId).status, 'done');
  assert.equal(motifsDb.listOccurrences(wasser.id).length, 1, 'gewähltes Motiv gescannt');
  assert.equal(motifsDb.listOccurrences(spiegel.id).length, 0, 'anderes Motiv unberührt');
});

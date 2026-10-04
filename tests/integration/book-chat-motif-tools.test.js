'use strict';
// Integration test: Book-Chat Tools get_motifs + get_motif_occurrences.
// Read-only Soll/Ist-Zugriff auf die Motiv-Werkstatt (themes/motifs/Brücken/
// motif_occurrences) aus dem agentischen Buch-Chat. Pro Buch + User skopiert.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookChatTools;
let motifDb;

test.before(() => {
  ctx = bootstrap();
  bookChatTools = require('../../routes/jobs/book-chat-tools');
  motifDb = require('../../db/motifs');
});
test.after(() => { ctx.cleanup(); });

test('get_motifs: leere Werkstatt → themes:[] + motifs:[] + hint', () => {
  const BOOK_ID = 7301;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const result = bookChatTools.TOOLS.get_motifs({}, {
    bookId: BOOK_ID, userEmail: 'autor@werk.dev',
  });
  assert.deepEqual(result.themes, []);
  assert.deepEqual(result.motifs, []);
  assert.match(result.hint, /Motiv-Werkstatt/);
});

test('get_motifs: Geist-Motiv (Soll-Link, 0 Fundstellen) → geist:true + geister-Zähler', () => {
  const BOOK_ID = 7302;
  const userEmail = 'autor@werk.dev';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'B' }],
    chapters: [{ id: 73020, book_id: BOOK_ID, name: 'Kapitel Eins' }],
    pages: [{ id: 73021, book_id: BOOK_ID, name: 'P1', chapter_id: 73020 }],
  });

  const theme = motifDb.createTheme(BOOK_ID, userEmail, { name: 'Schuld & Vergebung' });
  const motif = motifDb.createMotif(BOOK_ID, userEmail, {
    themeId: theme.id, name: 'Wasser', beschreibung: 'Reinigung', triggerTerms: ['Regen', 'Fluss'],
  });
  // Soll-Verknüpfung zu einem Kapitel, aber KEINE Fundstellen → Geist.
  motifDb.setMotifChapters(motif.id, [73020]);

  const result = bookChatTools.TOOLS.get_motifs({}, { bookId: BOOK_ID, userEmail });
  assert.equal(result.total_themes, 1);
  assert.equal(result.total_motifs, 1);
  assert.equal(result.geister, 1);

  const m = result.motifs[0];
  assert.equal(m.name, 'Wasser');
  assert.equal(m.thema, 'Schuld & Vergebung');
  assert.deepEqual(m.trigger_terms, ['Regen', 'Fluss']);
  assert.deepEqual(m.soll.kapitel, ['Kapitel Eins']);
  assert.equal(m.ist_count, 0);
  assert.equal(m.geist, true);
});

test('get_motifs: Motiv mit Fundstellen → ist_count gesetzt, kein Geist; Beziehungen auf Namen aufgelöst', () => {
  const BOOK_ID = 7303;
  const userEmail = 'autor@werk.dev';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'B' }],
    chapters: [{ id: 73030, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 73031, book_id: BOOK_ID, name: 'P1', chapter_id: 73030 }],
  });

  const mWasser = motifDb.createMotif(BOOK_ID, userEmail, { name: 'Wasser' });
  const mSpiegel = motifDb.createMotif(BOOK_ID, userEmail, { name: 'Spiegel' });
  motifDb.setMotifChapters(mWasser.id, [73030]);
  motifDb.replaceOccurrences(mWasser.id, BOOK_ID, [
    { kind: 'page', pageId: 73031, score: 0.87, snippet: 'Der Regen fiel.', source: 'semantic' },
  ]);
  motifDb.createRelation(mWasser.id, mSpiegel.id, 'spiegelt');

  const result = bookChatTools.TOOLS.get_motifs({}, { bookId: BOOK_ID, userEmail });
  assert.equal(result.geister, 0);
  const wasser = result.motifs.find(m => m.name === 'Wasser');
  assert.equal(wasser.ist_count, 1);
  assert.equal(wasser.geist, undefined);

  assert.equal(result.relations.length, 1);
  assert.deepEqual(result.relations[0], { von: 'Wasser', zu: 'Spiegel', typ: 'spiegelt' });
});

test('get_motif_occurrences: per motif_name → Fundstellen mit page/chapter + source', () => {
  const BOOK_ID = 7304;
  const userEmail = 'autor@werk.dev';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'B' }],
    chapters: [{ id: 73040, book_id: BOOK_ID, name: 'Am Fluss' }],
    pages: [{ id: 73041, book_id: BOOK_ID, name: 'Seite 3', chapter_id: 73040 }],
  });
  const motif = motifDb.createMotif(BOOK_ID, userEmail, { name: 'Wasser des Lebens' });
  motifDb.replaceOccurrences(motif.id, BOOK_ID, [
    { kind: 'page', pageId: 73041, score: 0.9, snippet: 'Das Wasser strömte.', source: 'semantic' },
    // Trigger-Fundstellen tragen keinen Score (motif-scan.js) — der Score-Floor lässt sie durch.
    { kind: 'page', pageId: 73041, score: null, snippet: 'Regen.', source: 'trigger' },
  ]);

  const result = bookChatTools.TOOLS.get_motif_occurrences(
    { motif_name: 'wasser' },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(result.name, 'Wasser des Lebens');
  assert.equal(result.ist_count, 2);
  assert.equal(result.occurrences.length, 2);
  // Nach Score sortiert (0.9 zuerst).
  const top = result.occurrences[0];
  assert.equal(top.kind, 'page');
  assert.equal(top.page_id, 73041);
  assert.equal(top.page_name, 'Seite 3');
  assert.equal(top.chapter_name, 'Am Fluss');
  assert.equal(top.source, 'semantic');
  assert.equal(top.score, 0.9);
  assert.match(top.snippet, /Wasser strömte/);
});

test('get_motif_occurrences: Geist-Motiv (0 Fundstellen) → occurrences:[] + hint', () => {
  const BOOK_ID = 7305;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');
  const motif = motifDb.createMotif(BOOK_ID, userEmail, { name: 'Leeres Motiv' });

  const result = bookChatTools.TOOLS.get_motif_occurrences(
    { motif_id: motif.id },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(result.ist_count, 0);
  assert.deepEqual(result.occurrences, []);
  assert.match(result.hint, /Geist|Scan/);
});

test('get_motif_occurrences: unbekanntes Motiv → error', () => {
  const BOOK_ID = 7306;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');
  const result = bookChatTools.TOOLS.get_motif_occurrences(
    { motif_name: 'existiert nicht' },
    { bookId: BOOK_ID, userEmail: 'autor@werk.dev' },
  );
  assert.equal(result.error, 'Motiv nicht gefunden');
});

test('get_motifs / get_motif_occurrences: cross-user + cross-book Isolation', () => {
  const BOOK_A = 7307;
  const BOOK_B = 7308;
  const me = 'me@werk.dev';
  const other = 'other@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_A, 'A');
  ctx.dbSchema.upsertBookByName(BOOK_B, 'B');

  motifDb.createMotif(BOOK_A, other, { name: 'FremdMotiv' });
  const mine = motifDb.createMotif(BOOK_B, me, { name: 'MeinMotiv' });

  // Fremder User im selben Buch sieht das Motiv nicht.
  const r1 = bookChatTools.TOOLS.get_motifs({}, { bookId: BOOK_A, userEmail: me });
  assert.equal(r1.total_motifs, 0);

  // Motiv aus Buch B ist in Buch A nicht auffindbar.
  const r2 = bookChatTools.TOOLS.get_motif_occurrences(
    { motif_id: mine.id },
    { bookId: BOOK_A, userEmail: me },
  );
  assert.equal(r2.error, 'Motiv nicht gefunden');
});

test('executeTool dispatch: get_motifs + get_motif_occurrences registriert', async () => {
  const BOOK_ID = 7310;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');
  const motif = motifDb.createMotif(BOOK_ID, userEmail, { name: 'Wasser' });

  const listRes = await bookChatTools.executeTool('get_motifs', {}, { bookId: BOOK_ID, userEmail });
  assert.equal(listRes.total_motifs, 1);

  const occRes = await bookChatTools.executeTool('get_motif_occurrences',
    { motif_id: motif.id },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(occRes.name, 'Wasser');
});

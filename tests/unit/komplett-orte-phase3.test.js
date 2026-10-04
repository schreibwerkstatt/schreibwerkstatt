'use strict';
// routes/jobs/komplett/phases/orte.js — Phase 3 (Orte) der Komplettanalyse.
//
// Abgesichert wird, was den Job abbrechen oder Verknüpfungen still verlieren liess:
//   * KI-Konsolidierung liefert doppelte ort_N → UNIQUE(book_id, loc_id, user_email)
//     → id wird IMMER neu vergeben (beide KI-Pfade, wie bei den Songs).
//   * Serieller KI-Pfad (ohne Prefetch, lokale Provider) löst figuren_namen auf.
//   * Output-Cap im maxTokens-Slot (9. Argument), nicht im expectedChars-Slot.
//   * Varianten, die in einem Ort aufgegangen sind, bleiben über ortNameToId auflösbar.
//   * Regelbasierter Fallback vereinigt Kapitel.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('komplett-orte-phase3');

require('../../db/migrations');
const { db } = require('../../db/connection');
const {
  runPhase3, buildFallbackOrte, buildOrtNameLookup, ortAliasesFromSources,
} = require('../../routes/jobs/komplett/phases/orte');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();
const log = { info() {}, warn() {} };
let seq = 0;

function newBook() {
  const bookId = 7700 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  const chapterId = 77000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(chapterId, bookId, 'Kapitel 1', 0, NOW);
  return { bookId, chapterId };
}

function makeCtx(bookId, chapterId, callImpl) {
  const calls = [];
  return {
    calls,
    ctx: {
      jobId: 'test-job', bookIdInt: bookId, email: USER, tok: { in: 0, out: 0 }, log,
      bookName: 'Testbuch', effectiveProvider: 'ollama', warnings: [],
      idMaps: { chNameToId: { 'Kapitel 1': chapterId }, pageNameToIdByChapter: {} },
      prompts: {
        buildLocationsConsolidationPrompt: () => 'prompt',
        SCHEMA_ORTE_KONSOL: { type: 'object' },
      },
      sys: { SYSTEM_ORTE_BLOCKS: [] },
      call: async (...args) => { calls.push(args); return callImpl(...args); },
    },
  };
}

test('runPhase3 seriell: doppelte ort_N der KI werden neu nummeriert, figuren_namen aufgelöst, Cap im maxTokens-Slot', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx, calls } = makeCtx(bookId, chapterId, () => ({
    orte: [
      { id: 'ort_1', name: 'Burg Falkenstein', typ: 'GEBAEUDE', figuren_namen: ['Anna'], kapitel: ['Kapitel 1'] },
      { id: 'ort_1', name: 'Marktplatz', typ: 'ANDERE', figuren_namen: ['Bert'], kapitel: ['Kapitel 1'] },
    ],
  }));
  const chapterOrte = [{ kapitel: 'Kapitel 1', orte: [{ name: 'Burg Falkenstein' }, { name: 'Marktplatz' }] }];
  const { orte, ortNameToId } = await runPhase3(ctx, chapterOrte, [], false,
    { Anna: 'fig_1', Bert: 'fig_2' }, { anna: 'fig_1', bert: 'fig_2' });

  assert.deepEqual(orte.map(o => o.id), ['ort_1', 'ort_2']);
  assert.deepEqual(orte.map(o => o.figuren), [['fig_1'], ['fig_2']]);
  assert.equal(ortNameToId.Marktplatz, 'ort_2');
  const rows = db.prepare('SELECT loc_id FROM locations WHERE book_id = ? ORDER BY loc_id').all(bookId);
  assert.deepEqual(rows.map(r => r.loc_id), ['ort_1', 'ort_2']);

  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[6], null, 'expectedChars-Slot bleibt frei');
  assert.ok(Number.isFinite(args[8]) && args[8] > 0, 'Cap steht im maxTokens-Slot');
});

test('runPhase3 prefetched: doppelte ort_N werden ebenfalls neu nummeriert', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx } = makeCtx(bookId, chapterId, () => { throw new Error('darf nicht rufen'); });
  const prefetchedOrteRaw = { orte: [
    { id: 'ort_3', name: 'Kirche', figuren_namen: [] },
    { id: 'ort_3', name: 'Schule', figuren_namen: [] },
  ] };
  const { orte } = await runPhase3(ctx, [], [], false, {}, {}, { prefetchedOrteRaw });
  assert.deepEqual(orte.map(o => o.id), ['ort_1', 'ort_2']);
});

test('runPhase3 Single-Pass: im Dedup aufgegangene Variante bleibt auflösbar', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx } = makeCtx(bookId, chapterId, () => { throw new Error('kein Call im Single-Pass'); });
  const chapterOrte = [{ kapitel: '', orte: [
    { name: 'Mathys AG', typ: 'GEBAEUDE' },
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE' },
  ] }];
  const { orte, ortNameToId, ortNameToIdLower } = await runPhase3(ctx, chapterOrte, [], true, {}, {});
  assert.equal(orte.length, 1);
  assert.equal(ortNameToId['Mathys AG'], orte[0].id);
  assert.equal(ortNameToIdLower['mathys ag'], orte[0].id);
});

test('buildFallbackOrte: Kapitel werden vereinigt, Rohdaten bleiben unverändert', () => {
  const chapterOrte = [
    { kapitel: 'K1', orte: [{ name: 'Wald', kapitel: [{ name: 'K1', haeufigkeit: 1 }] }] },
    { kapitel: 'K2', orte: [{ name: 'wald', kapitel: [{ name: 'K2', haeufigkeit: 2 }, { name: 'K1', haeufigkeit: 4 }] }] },
  ];
  const out = buildFallbackOrte(chapterOrte, {}, {});
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].kapitel, [{ name: 'K1', haeufigkeit: 4 }, { name: 'K2', haeufigkeit: 2 }]);
  assert.deepEqual(chapterOrte[0].orte[0].kapitel, [{ name: 'K1', haeufigkeit: 1 }], 'Eingabe nicht mutiert');
});

test('buildOrtNameLookup: Alias überschreibt nie einen echten Ortsnamen', () => {
  const orte = [{ id: 'ort_1', name: 'Bahnhof Olten' }, { id: 'ort_2', name: 'Bahnhof' }];
  const { ortNameToId } = buildOrtNameLookup(orte, [['Bahnhof', 'Olten Bahnhof'], []]);
  assert.equal(ortNameToId.Bahnhof, 'ort_2');
  assert.equal(ortNameToId['Olten Bahnhof'], 'ort_1');
});

test('ortAliasesFromSources: eindeutige Variante wird Alias, mehrdeutige nicht', () => {
  const orte = [
    { name: 'Mathys AG Produktionsstätte Bettlach', typ: 'GEBAEUDE' },
    { name: 'Restaurant Kreuz (Olten)', typ: 'GEBAEUDE' },
    { name: 'Restaurant Kreuz (Bern)', typ: 'GEBAEUDE' },
  ];
  const aliases = ortAliasesFromSources(orte, [{ kapitel: 'K1', orte: [
    { name: 'Mathys AG Bettlach', typ: 'GEBAEUDE' },
    { name: 'Restaurant Kreuz', typ: 'GEBAEUDE' },
    { name: 'Restaurant Kreuz (Olten)', typ: 'GEBAEUDE' },
  ] }]);
  assert.deepEqual(aliases[0], ['Mathys AG Bettlach']);
  assert.deepEqual(aliases[1], []);
  assert.deepEqual(aliases[2], []);
});

'use strict';
// Fallback-Merges der Komplettanalyse-Konsolidierung (Figuren · Orte · Songs).
//
// Abgesichert wird:
//   * lib/entity-match/merge-fields.js: Kapitel-Union (höherer Wert vs. Summe), Auffüllen.
//   * Figuren: Varianten nach der Konsolidierung zählen je Kapitel den höheren Wert, der
//     Vorab-Merge über Chunks die Summe.
//   * Orte/Songs: was die KI-Konsolidierung weder übernimmt noch (laut `quellnamen` bzw.
//     Regel) zusammenführt, kommt aus den Kapiteln zurück; Quellnamen werden Aliasse.
//   * Songs: Vorab-Prüfung gegen das Cap — kein Call, wenn die Truncation sicher ist.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('komplett-konsol-restore');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { unionKapitel, fillEmpty, findOmitted } = require('../../lib/entity-match/merge-fields');
const { preMergeChapterFiguren, mergeDuplicateFiguren } = require('../../routes/jobs/komplett/figuren-merge');
const {
  runPhase3, runPhase3Songs, restoreOmittedOrte, restoreOmittedSongs, ortAliasesFromSources,
} = require('../../routes/jobs/komplett/phases/orte');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();
const log = { info() {}, warn() {}, error() {} };
let seq = 0;

function newBook() {
  const bookId = 8800 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  const chapterId = 88000 + (++seq);
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
        buildSongsConsolidationPrompt: () => 'prompt',
        SCHEMA_ORTE_KONSOL: { type: 'object' },
        SCHEMA_SONGS_KONSOL: { type: 'object' },
      },
      sys: { SYSTEM_ORTE_BLOCKS: [] },
      call: async (...args) => { calls.push(args); return callImpl(...args); },
    },
  };
}

// ── merge-fields ─────────────────────────────────────────────────────────────

test('unionKapitel: höherer Wert per Default, Summe mit sum, neue Kapitel kopiert', () => {
  const src = [{ name: 'K1', haeufigkeit: 3 }, { name: 'K2', haeufigkeit: 1 }];
  const max = unionKapitel({ kapitel: [{ name: 'K1', haeufigkeit: 2 }] }, src);
  assert.deepEqual(max.kapitel, [{ name: 'K1', haeufigkeit: 3 }, { name: 'K2', haeufigkeit: 1 }]);
  assert.notEqual(max.kapitel[1], src[1], 'übernommener Eintrag ist eine Kopie');
  const sum = unionKapitel({ kapitel: [{ name: 'K1', haeufigkeit: 2 }] }, src, { sum: true });
  assert.equal(sum.kapitel[0].haeufigkeit, 5);
});

test('unionKapitel: fallback zählt Einträge ohne Zahl, ohne fallback wird keine 0 erfunden', () => {
  const fig = unionKapitel({ kapitel: [{ name: 'K1' }] }, [{ name: 'K1' }], { sum: true, fallback: 1 });
  assert.equal(fig.kapitel[0].haeufigkeit, 2);
  const ort = unionKapitel({ kapitel: [{ name: 'K1' }] }, [{ name: 'K1' }]);
  assert.deepEqual(ort.kapitel, [{ name: 'K1' }]);
  const str = unionKapitel({ kapitel: ['K1'] }, ['K1', 'K2']);
  assert.deepEqual(str.kapitel, ['K1', 'K2']);
});

test('fillEmpty: füllt nur leere Felder', () => {
  const t = fillEmpty({ a: 'x', b: '' }, { a: 'y', b: 'z', c: 'w' }, ['a', 'b']);
  assert.deepEqual(t, { a: 'x', b: 'z' });
});

test('findOmitted: jeder Schlüssel einmal, abgedeckte fallen weg', () => {
  const out = findOmitted([{ orte: [{ name: 'A' }, { name: 'B' }] }, { orte: [{ name: 'b' }, { name: 'C' }] }], 'orte', {
    keyOf: o => o.name.toLowerCase(), isCovered: o => o.name === 'A',
  });
  assert.deepEqual(out.map(o => o.name), ['B', 'C']);
});

// ── Figuren: Häufigkeit ──────────────────────────────────────────────────────

test('mergeDuplicateFiguren: Varianten zählen je Kapitel den höheren Wert, nicht die Summe', () => {
  const { figuren } = mergeDuplicateFiguren([
    { id: 'fig_1', name: 'Anna Weber', kapitel: [{ name: 'K1', haeufigkeit: 4 }] },
    { id: 'fig_2', name: 'anna weber', kapitel: [{ name: 'K1', haeufigkeit: 3 }, { name: 'K2', haeufigkeit: 1 }] },
  ]);
  assert.equal(figuren.length, 1);
  assert.deepEqual(figuren[0].kapitel, [{ name: 'K1', haeufigkeit: 4 }, { name: 'K2', haeufigkeit: 1 }]);
});

test('preMergeChapterFiguren: über Chunks gleichen Kapitels wird summiert', () => {
  const { chapterFiguren } = preMergeChapterFiguren([
    { kapitel: 'K1', figuren: [{ id: 'a', name: 'Anna', kapitel: [{ name: 'K1', haeufigkeit: 2 }] }] },
    { kapitel: 'K1', figuren: [{ id: 'b', name: 'Anna', kapitel: [{ name: 'K1', haeufigkeit: 3 }] }] },
  ]);
  assert.deepEqual(chapterFiguren[0].figuren[0].kapitel, [{ name: 'K1', haeufigkeit: 5 }]);
});

// ── Orte: Rückholen + Quellnamen ─────────────────────────────────────────────

test('restoreOmittedOrte: weggelassener Ort kommt zurück, Quellname und SAME-Variante nicht', () => {
  const ki = [
    { name: 'Festung Hohenstein', typ: 'gebaeude', quellnamen: ['die Burg', 'Festung Hohenstein'] },
    { name: 'Mathys AG', typ: 'gebaeude', quellnamen: [] },
  ];
  const chapterOrte = [
    { kapitel: 'K1', orte: [{ name: 'die Burg', typ: 'gebaeude' }, { name: 'Bahnhof Olten', typ: 'gebaeude', figuren_namen: ['Anna'], kapitel: [{ name: 'K1', haeufigkeit: 2 }] }] },
    { kapitel: 'K2', orte: [{ name: 'Mathys AG Produktionsstätte Bettlach', typ: 'gebaeude' }, { name: 'bahnhof olten', typ: 'gebaeude', kapitel: [{ name: 'K2', haeufigkeit: 1 }] }] },
  ];
  const { restored, quellOf } = restoreOmittedOrte(ki, chapterOrte, { Anna: 'fig_1' }, { anna: 'fig_1' });
  assert.deepEqual(restored.map(o => o.name), ['Bahnhof Olten']);
  assert.deepEqual(restored[0].figuren, ['fig_1']);
  assert.deepEqual(restored[0].kapitel.map(k => k.name), ['K1', 'K2'], 'Kapitel über alle Vorkommen');
  assert.equal(quellOf.get('die burg'), 'Festung Hohenstein');
  assert.ok(ki.every(o => !('quellnamen' in o)), 'quellnamen werden entfernt');
});

test('restoreOmittedOrte: gleicher Katalog-Anker gilt als abgedeckt', () => {
  const { restored } = restoreOmittedOrte(
    [{ name: 'Schloss', katalog_id: 'O7', quellnamen: [] }],
    [{ kapitel: 'K1', orte: [{ name: 'Altes Gemäuer am See', katalog_id: 'O7' }] }], {}, {});
  assert.equal(restored.length, 0);
});

test('ortAliasesFromSources: Quellname wird Alias, auch für reine Synonyme', () => {
  const orte = [{ name: 'Festung Hohenstein', typ: 'gebaeude' }, { name: 'Marktplatz', typ: 'andere' }];
  const aliases = ortAliasesFromSources(orte, [{ orte: [{ name: 'die Burg' }] }], new Map([['die burg', 'Festung Hohenstein']]));
  assert.deepEqual(aliases, [['die Burg'], []]);
});

test('runPhase3 Multi-Pass: von der KI weggelassener Ort wird gespeichert, Synonym bleibt auflösbar', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx } = makeCtx(bookId, chapterId, () => ({
    orte: [{ name: 'Festung Hohenstein', typ: 'gebaeude', figuren_namen: [], kapitel: ['Kapitel 1'], quellnamen: ['die Burg'] }],
  }));
  const chapterOrte = [{ kapitel: 'Kapitel 1', orte: [
    { name: 'die Burg', typ: 'gebaeude', kapitel: ['Kapitel 1'] },
    { name: 'Gasthaus zum Löwen', typ: 'gebaeude', kapitel: ['Kapitel 1'] },
  ] }];
  const { orte, ortNameToId } = await runPhase3(ctx, chapterOrte, [], false, {}, {});
  assert.deepEqual(orte.map(o => o.name).sort(), ['Festung Hohenstein', 'Gasthaus zum Löwen']);
  assert.equal(ortNameToId['die Burg'], orte.find(o => o.name === 'Festung Hohenstein').id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM locations WHERE book_id = ?').get(bookId).n, 2);
});

// ── Songs ────────────────────────────────────────────────────────────────────

test('restoreOmittedSongs: weggelassener Song zurück, Quellname/ohne Interpret abgedeckt, Cover nicht', () => {
  const ki = [
    { titel: 'Yesterday', interpret: 'The Beatles', quellnamen: ['Yesterday (Remastered)'] },
    { titel: 'Hallelujah', interpret: 'Leonard Cohen', quellnamen: [] },
  ];
  const chapterSongs = [{ kapitel: 'K1', songs: [
    { titel: 'Yesterday (Remastered)', interpret: 'Beatles' },
    { titel: 'Hallelujah' },
    { titel: 'Hallelujah', interpret: 'Jeff Buckley' },
    { titel: 'Bohemian Rhapsody', interpret: 'Queen', kapitel: [{ name: 'K1', haeufigkeit: 1 }] },
  ] }];
  const restored = restoreOmittedSongs(ki, chapterSongs, {}, {});
  assert.deepEqual(restored.map(s => `${s.titel}|${s.interpret}`).sort(),
    ['Bohemian Rhapsody|Queen', 'Hallelujah|Jeff Buckley']);
  assert.ok(ki.every(s => !('quellnamen' in s)));
});

test('runPhase3Songs: weggelassener Song wird gespeichert', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx } = makeCtx(bookId, chapterId, () => ({
    songs: [{ titel: 'Yesterday', interpret: 'The Beatles', kontext_typ: 'hört', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], figuren_namen: [], quellnamen: [] }],
  }));
  const chapterSongs = [
    { kapitel: 'Kapitel 1', songs: [{ titel: 'Yesterday', interpret: 'The Beatles', kontext_typ: 'hört' }] },
    { kapitel: 'Kapitel 1', songs: [{ titel: 'Imagine', interpret: 'John Lennon', kontext_typ: 'erwähnt', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }] }] },
  ];
  await runPhase3Songs(ctx, chapterSongs, [], false, {}, {});
  const titel = db.prepare('SELECT titel FROM songs WHERE book_id = ? ORDER BY titel').all(bookId).map(r => r.titel);
  assert.deepEqual(titel, ['Imagine', 'Yesterday']);
});

test('runPhase3Songs: passt die Antwort sicher nicht unter den Cap, kein Call, Fallback mit Warnung', async () => {
  const { bookId, chapterId } = newBook();
  const { ctx, calls } = makeCtx(bookId, chapterId, () => { throw new Error('darf nicht rufen'); });
  const lang = 'x'.repeat(4000);
  const songs = Array.from({ length: 400 }, (_, i) => ({ titel: `Song ${i}`, interpret: 'Band', kontext_typ: 'hört', beschreibung: lang }));
  await runPhase3Songs(ctx, [{ kapitel: 'Kapitel 1', songs }], [], false, {}, {});
  assert.equal(calls.length, 0);
  assert.ok(ctx.warnings.some(w => w.key === 'job.warn.songsKonsolidierungDegraded'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM songs WHERE book_id = ?').get(bookId).n, 400);
});

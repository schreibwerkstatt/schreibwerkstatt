'use strict';
// Unit (Temp-DB): Attribut-Widerspruchs-Detektor (F4) und Verify-Stufe der Kontinuität.
//  - „Auftritt nach dem Tod" auch im SELBEN Kapitel auf einer späteren Seite.
//  - Synthetische Werte (Szenen-Titel) tragen keine Anführungszeichen, die _stelleQuote
//    als Buchzitat läse → der Befund fiele sonst der Zitat-Beleg-Prüfung zum Opfer.
//  - Jeder F4-Befund trägt `_source: 'attr'`; Urteils-Call mit 4000er-Deckel + Effort 'low';
//    fehlgeschlagene Einzel-Urteile werden gemeldet statt still verworfen.
//  - Verify: 4000er-Deckel + Effort 'low', der `grund` eines Verwerfens landet im Log.
//  - Faktencheck-Judge bucht seine Tool-Runden in den Kosten-Bucket `factcheck`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('attribute-check');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const {
  buildAttributeContradictions, runAttributeContradictionCheck, ATTR_SOURCE,
} = require('../../routes/jobs/komplett/attribute-check');
const { verifyKontinuitaetProbleme } = require('../../routes/jobs/komplett/job-shared');
const { _stelleQuote } = require('../../routes/jobs/komplett/utils');
const { COST_LABEL } = require('../../routes/jobs/komplett/cost-labels');

const USER = 'attr@example.com';
const NOW = '2026-10-04T10:00:00.000Z';
let seq = 0;

function newBook() {
  const bookId = 7000 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  return bookId;
}
function addChapter(bookId, name, pos) {
  const id = 71000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, bookId, name, pos, NOW);
  return id;
}
function addPage(bookId, chapterId, name, pos) {
  const id = 72000 + (++seq);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, bookId, chapterId, name, '<p>x</p>', pos, NOW);
  return id;
}
function addFigur(bookId, figId, name) {
  db.prepare('INSERT INTO figures (book_id, fig_id, name, updated_at, user_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, figId, name, NOW, USER);
  return db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?').get(bookId, figId).id;
}
function addDeath(figureId, chapterId, pageId) {
  db.prepare(`INSERT INTO figure_events (figure_id, datum, datum_year, ereignis, subtyp, chapter_id, page_id, datum_unsicher)
              VALUES (?, '1944', 1944, 'stirbt', 'tod', ?, ?, 0)`).run(figureId, chapterId, pageId);
}
function addScene(bookId, figureId, titel, chapterId, pageId) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, page_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(bookId, USER, titel, chapterId, pageId, NOW);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(lastInsertRowid, figureId);
}

/** Buch mit einem Kapitel, drei Seiten; Marek stirbt auf Seite 2. */
function sameChapterBook() {
  const bookId = newBook();
  const k1 = addChapter(bookId, 'Eins', 1);
  const p1 = addPage(bookId, k1, 'S1', 1);
  const p2 = addPage(bookId, k1, 'S2', 2);
  const p3 = addPage(bookId, k1, 'S3', 3);
  const marek = addFigur(bookId, 'fig_m', 'Marek');
  addDeath(marek, k1, p2);
  return { bookId, k1, p1, p2, p3, marek };
}

test('T: Szene auf späterer Seite im selben Kapitel → Kandidat (mit Seitenreihenfolge)', () => {
  const { bookId, k1, p1, p2, p3, marek } = sameChapterBook();
  addScene(bookId, marek, 'Marek im Keller', k1, p1);
  addScene(bookId, marek, 'Marek steht wieder auf', k1, p3);
  const cands = buildAttributeContradictions(bookId, USER, { chapterOrder: [k1], pageOrder: [p1, p2, p3] });
  const tod = cands.find(c => c.attribut === 'Lebendig/tot');
  assert.ok(tod, 'Tod-Kandidat im selben Kapitel');
  assert.match(tod.wertB.wert, /Marek steht wieder auf/);
  assert.match(tod.hinweis, /SELBEN Kapitel/);

  // Ohne Seitenreihenfolge kein Vergleich innerhalb des Kapitels.
  assert.equal(buildAttributeContradictions(bookId, USER, { chapterOrder: [k1] })
    .some(c => c.attribut === 'Lebendig/tot'), false);
});

test('T: Szene nur auf früherer/gleicher Seite im Todeskapitel → kein Kandidat', () => {
  const { bookId, k1, p1, p2, p3, marek } = sameChapterBook();
  addScene(bookId, marek, 'Marek im Keller', k1, p1);
  addScene(bookId, marek, 'Marek stirbt', k1, p2);
  const cands = buildAttributeContradictions(bookId, USER, { chapterOrder: [k1], pageOrder: [p1, p2, p3] });
  assert.equal(cands.some(c => c.attribut === 'Lebendig/tot'), false);
});

test('T: Szenen-Titel mit Anführungszeichen → Wert ohne Zitat-Klammer, _stelleQuote leer', () => {
  const bookId = newBook();
  const k1 = addChapter(bookId, 'Eins', 1);
  const k2 = addChapter(bookId, 'Zwei', 2);
  const marek = addFigur(bookId, 'fig_m', 'Marek');
  addDeath(marek, k1, null);
  addScene(bookId, marek, '«Die Rückkehr» und „das Fest"', k2, null);
  const tod = buildAttributeContradictions(bookId, USER, { chapterOrder: [k1, k2] })
    .find(c => c.attribut === 'Lebendig/tot');
  assert.ok(tod);
  assert.doesNotMatch(tod.wertB.wert, /[«»„"“”]/);
  assert.match(tod.wertB.wert, /Die Rückkehr und das Fest/);
  assert.equal(_stelleQuote(`${tod.attribut}: ${tod.wertB.wert} (Kapitel Zwei)`), '');
});

function judgeCtx(bookId, chapterOrder, { reject = false } = {}) {
  const calls = [];
  const logs = { info: [], warn: [] };
  const warnings = [];
  let n = 0;
  return {
    calls, logs, warnings,
    ctx: {
      call: async (...args) => {
        calls.push(args);
        if (reject && n++ === 0) throw new Error('aiTruncated');
        return { widerspruch: true, schwere: 'kritisch', beschreibung: 'Tot und doch da.', empfehlung: 'Prüfen.' };
      },
      prompts: { buildAttributeContradictionJudgePrompt: () => 'p', SCHEMA_ATTR_CONTRADICTION: {} },
      sys: { SYSTEM_KONTINUITAET_BLOCKS: '' },
      jobId: 'no-such-job', tok: { in: 0, out: 0 }, bookName: 'B', bookIdInt: bookId, email: USER,
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
      groupOrder: chapterOrder.map(String), pageContents: [], warnings,
    },
  };
}

function twoChapterDeathBook() {
  const bookId = newBook();
  const k1 = addChapter(bookId, 'Eins', 1);
  const k2 = addChapter(bookId, 'Zwei', 2);
  const marek = addFigur(bookId, 'fig_m', 'Marek');
  const lena = addFigur(bookId, 'fig_l', 'Lena');
  addDeath(marek, k1, null);
  addDeath(lena, k1, null);
  addScene(bookId, marek, 'Marek kehrt heim', k2, null);
  addScene(bookId, lena, 'Lena tanzt', k2, null);
  return { bookId, k1, k2 };
}

test('runAttributeContradictionCheck: Befund trägt _source=attr; Call mit 4000er-Deckel + Effort low', async () => {
  const { bookId, k1, k2 } = twoChapterDeathBook();
  const { ctx, calls, warnings } = judgeCtx(bookId, [k1, k2]);
  const findings = await runAttributeContradictionCheck(ctx, 97, 98);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f._source, ATTR_SOURCE);
    assert.equal(f._source, 'attr');
    assert.equal(_stelleQuote(f.stelle_b), '', 'stelle_b ohne Zitat-Klammer');
  }
  const args = calls[0];
  assert.equal(args[8], 4000, 'maxTokens');
  assert.deepEqual(args[10], { label: COST_LABEL.kontinuitaet, effort: 'low' });
  assert.deepEqual(warnings, []);
});

test('runAttributeContradictionCheck: fehlgeschlagenes Urteil → log.warn + Warnung, Rest bleibt', async () => {
  const { bookId, k1, k2 } = twoChapterDeathBook();
  const { ctx, logs, warnings } = judgeCtx(bookId, [k1, k2], { reject: true });
  const findings = await runAttributeContradictionCheck(ctx, 97, 98);
  assert.equal(findings.length, 1);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /1\/2 Urteile fehlgeschlagen/);
  assert.deepEqual(warnings, [{ key: 'job.warn.attributeCheckPartial', params: { failed: 1, total: 2 } }]);
});

test('verifyKontinuitaetProbleme: 4000er-Deckel + Effort low, Grund des Verwerfens im Info-Log', async () => {
  const groups = new Map([['k1', { name: 'Kapitel Eins', pages: [{ id: 5, text: 'Anna ging heim. Es regnete.' }] }]]);
  const calls = [];
  const infos = [];
  const ctx = {
    call: async (...args) => { calls.push(args); return { bestaetigt: false, grund: 'Rückblende,\n kein Widerspruch' }; },
    prompts: { buildKontinuitaetVerifyPrompt: () => 'p', SCHEMA_KONTINUITAET_VERIFY: {} },
    sys: { SYSTEM_KONTINUITAET_BLOCKS: '' },
    jobId: 'no-such-job', tok: { in: 0, out: 0 }, bookName: 'B',
    groups, groupOrder: ['k1'], log: { info: (m) => infos.push(m), warn() {} }, bookIdInt: null,
  };
  const out = await verifyKontinuitaetProbleme(ctx, { zusammenfassung: 'z', probleme: [
    { beschreibung: 'Anna widerspricht sich', kapitel: ['Kapitel Eins'], stelle_a: '«Anna ging heim»', stelle_b: '' },
  ] }, 95, 97);
  assert.equal(out.probleme.length, 0);
  assert.equal(calls[0][8], 4000);
  assert.deepEqual(calls[0][10], { label: COST_LABEL.kontinuitaet, effort: 'low' });
  assert.ok(infos.some(m => /Anna widerspricht sich/.test(m) && /Rückblende, kein Widerspruch/.test(m)), infos.join('\n'));
});

test('_judgeOneFact: jede Tool-Runde landet im Kosten-Bucket factcheck', async () => {
  const { _judgeOneFact } = require('../../routes/jobs/komplett/job-faktencheck');
  const { summarizeCostByPhase } = require('../../routes/jobs/shared');
  const tok = { in: 0, out: 0, ms: 0 };
  let turn = 0;
  const stub = async () => (turn++ === 0
    ? { text: '', stopReason: 'pause_turn', rawContentBlocks: [], tokensIn: 100, tokensOut: 10, cacheReadIn: 50, genDurationMs: 1000 }
    : { text: '{"urteil":"korrekt"}', stopReason: 'end_turn', tokensIn: 200, tokensOut: 20, genDurationMs: 2000 });
  const text = await _judgeOneFact(tok, 'prompt', 'system', null, stub);
  assert.equal(text, '{"urteil":"korrekt"}');
  assert.equal(tok.in, 300);
  assert.equal(tok.out, 30);
  assert.equal(tok.ms, 3000);
  const e = tok.byPhase[COST_LABEL.factcheck];
  assert.ok(e, 'Bucket factcheck vorhanden');
  assert.equal(e.calls, 2);
  assert.equal(e.tokensIn, 300);
  assert.equal(e.cacheReadIn, 50);
  const sum = summarizeCostByPhase(tok);
  assert.deepEqual(sum.phases.map(p => p.phase), ['factcheck']);
});

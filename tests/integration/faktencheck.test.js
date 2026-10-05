'use strict';
// Weltfakten-Faktencheck: Kandidaten-Builder (Opt-in-Gating, Kategorie-Filter, Cap,
// Kapitel-Gruppierung) + saveFaktencheckIssues (Anhang an neuesten Check, idempotenter
// faktenfehler-Ersatz, Kontinuitäts-Befunde bleiben erhalten, Neuanlage ohne Check) + der
// Truncated-/pause_turn-Umgang des Web-Such-Judges (`_judgeOneFact`, Tool-Call injiziert).

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('./_helpers/setup');

let db, buildFactCheckCandidates, saveFaktencheckIssues, saveContinuityCheck, getLatestContinuityCheck;

const BOOK = 9100;
const EMAIL = 'autor@test.dev';

function seedFacts() {
  db.prepare('DELETE FROM world_facts WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM world_fact_verdicts WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM continuity_issues WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM continuity_checks WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM chapters WHERE book_id = ?').run(BOOK);
  db.prepare('INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(BOOK, 'Faktencheck-Buch', new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?,?,?,?,?)')
    .run(91001, BOOK, 'Kapitel 1', 0, new Date().toISOString());
  const insWf = db.prepare(
    'INSERT INTO world_facts (book_id, user_email, kategorie, subjekt, fakt, sort_order) VALUES (?,?,?,?,?,?)'
  );
  const ins = (kat, subj, fakt, i) => insWf.run(BOOK, EMAIL, kat, subj, fakt, i).lastInsertRowid;
  const idHist = ins('historie', 'Mondlandung', 'fand 1968 statt', 0);
  ins('technik', 'Smartphone', 'gab es 1985', 1);
  ins('ereignis', 'Mauerfall', 'war 1989', 2);
  ins('kultur', 'Brauch X', 'wird begangen', 3);
  ins('ort', 'Bern', 'liegt in der Schweiz', 4);
  // Nicht-prüfbare Kategorien → dürfen NICHT als Kandidat auftauchen.
  ins('figur', 'Anna', 'ist mutig', 5);
  ins('objekt', 'Schwert', 'ist scharf', 6);
  ins('regel', 'Magie', 'kostet Kraft', 7);
  // Kapitel-Link für den historie-Fakt.
  db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(idHist, 91001);
}

function setFlag(on, orteReal = false) {
  db.prepare(`INSERT INTO book_settings (book_id, weltfakten_real_pruefen, orte_real, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(book_id) DO UPDATE SET weltfakten_real_pruefen=excluded.weltfakten_real_pruefen,
                                                 orte_real=excluded.orte_real`)
    .run(BOOK, on ? 1 : 0, orteReal ? 1 : 0, new Date().toISOString());
}

before(() => {
  bootstrap();
  ({ db } = require('../../db/connection'));
  ({ buildFactCheckCandidates } = require('../../routes/jobs/komplett/job-faktencheck'));
  ({ saveFaktencheckIssues, saveContinuityCheck, getLatestContinuityCheck } = require('../../db/schema'));
});

beforeEach(() => { seedFacts(); });

test('buildFactCheckCandidates: Opt-in aus → leer', () => {
  setFlag(false);
  const { candidates, total } = buildFactCheckCandidates(BOOK, EMAIL);
  assert.equal(candidates.length, 0);
  assert.equal(total, 0);
});

test('buildFactCheckCandidates: nur welt-externe Kategorien, Kapitel-Gruppierung', () => {
  setFlag(true);
  const { candidates } = buildFactCheckCandidates(BOOK, EMAIL);
  const kats = candidates.map(c => c.kategorie).sort();
  assert.deepEqual(kats, ['ereignis', 'historie', 'kultur', 'technik']);
  // figur/objekt/regel ausgeschlossen; ort nur bei realen Schauplätzen (orte_real)
  assert.ok(!candidates.some(c => ['figur', 'objekt', 'regel'].includes(c.kategorie)));
  const hist = candidates.find(c => c.subjekt === 'Mondlandung');
  assert.deepEqual(hist.kapitel, ['Kapitel 1']);
});

test('buildFactCheckCandidates: ort nur mit orte_real', () => {
  setFlag(true, true);
  const { candidates } = buildFactCheckCandidates(BOOK, EMAIL);
  assert.ok(candidates.some(c => c.kategorie === 'ort'));
});

test('buildFactCheckCandidates: gleiche Aussage zweimal → ein Kandidat', () => {
  setFlag(true);
  db.prepare('INSERT INTO world_facts (book_id, user_email, kategorie, subjekt, fakt, sort_order) VALUES (?,?,?,?,?,?)')
    .run(BOOK, EMAIL, 'historie', 'mondlandung', 'Fand 1968 statt.', 50);
  const { candidates } = buildFactCheckCandidates(BOOK, EMAIL);
  assert.equal(candidates.filter(c => c.subjekt.toLowerCase() === 'mondlandung').length, 1);
});

test('buildFactCheckCandidates: geurteilte Aussagen fallen weg, «unklar» kommt hinten wieder', () => {
  setFlag(true);
  const { saveFactVerdicts, worldFactKey } = require('../../db/schema');
  saveFactVerdicts(BOOK, EMAIL, [
    { key: worldFactKey('Mondlandung', 'fand 1968 statt'), urteil: 'falsch', quelle: 'https://example.org/a' },
    { key: worldFactKey('Smartphone', 'gab es 1985'), urteil: 'korrekt' },
    { key: worldFactKey('Mauerfall', 'war 1989'), urteil: 'unklar' },
  ]);
  const { candidates, pending, total } = buildFactCheckCandidates(BOOK, EMAIL);
  assert.equal(total, 4);
  assert.equal(pending, 2);
  assert.deepEqual(candidates.map(c => c.subjekt), ['Brauch X', 'Mauerfall']);
});

test('faktenfehlerIssues: «falsch»-Urteile werden in jeden neuen Kontinuitäts-Check nachgezogen', () => {
  setFlag(true);
  const { saveFactVerdicts, worldFactKey, faktenfehlerIssues } = require('../../db/schema');
  saveFactVerdicts(BOOK, EMAIL, [{ key: worldFactKey('Mondlandung', 'fand 1968 statt'), urteil: 'falsch',
    quelle: 'https://example.org/apollo', beschreibung: '1969' }]);
  const issues = faktenfehlerIssues(BOOK, EMAIL);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].stelle_a, 'Mondlandung: fand 1968 statt');
  assert.deepEqual(issues[0].kapitel, ['Kapitel 1']);
  // Neuer Kontinuitäts-Check (wie nach einer Komplettanalyse) + Nachziehen.
  const { saveKontinuitaetResult } = require('../../routes/jobs/komplett/remap');
  const log = { info() {}, warn() {} };
  saveKontinuitaetResult(BOOK, EMAIL, { zusammenfassung: 'neu', probleme: [] }, {}, { 'Kapitel 1': 91001 }, 'claude', log);
  const latest = getLatestContinuityCheck(BOOK, EMAIL);
  assert.equal(latest.issues.filter(i => i.typ === 'faktenfehler').length, 1);
});

test('buildFactCheckCandidates: Cap greift, total zählt alle', () => {
  setFlag(true);
  const insWf = db.prepare('INSERT INTO world_facts (book_id, user_email, kategorie, subjekt, fakt, sort_order) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 30; i++) insWf.run(BOOK, EMAIL, 'historie', `Fakt ${i}`, `behauptung ${i}`, 100 + i);
  const { candidates, total } = buildFactCheckCandidates(BOOK, EMAIL);
  assert.equal(candidates.length, 20); // _FACTCHECK_CANDIDATE_CAP
  assert.ok(total > 20);
});

test('saveFaktencheckIssues: hängt an neuesten Check an, Kontinuitäts-Befunde bleiben', () => {
  setFlag(true);
  // Bestehender Kontinuitäts-Check mit einem Nicht-faktenfehler-Issue.
  saveContinuityCheck(BOOK, EMAIL, 'Kont-Zusammenfassung', 'test-model',
    [{ schwere: 'mittel', typ: 'figur', beschreibung: 'Widerspruch', stelle_a: 'A', stelle_b: 'B', figuren: [], kapitel: [] }],
    {}, {});
  const before = getLatestContinuityCheck(BOOK, EMAIL);
  const checkId = before.id;
  assert.equal(before.issues.length, 1);

  saveFaktencheckIssues(BOOK, EMAIL, 'test-model',
    [{ schwere: 'kritisch', typ: 'faktenfehler', beschreibung: 'Mondlandung war 1969', stelle_a: 'Mondlandung: fand 1968 statt', stelle_b: '', quelle: 'https://example.org/apollo11', figuren: [], kapitel: ['Kapitel 1'] }],
    {}, { 'Kapitel 1': 91001 });

  const after = getLatestContinuityCheck(BOOK, EMAIL);
  assert.equal(after.id, checkId, 'kein neuer Check angelegt');
  assert.equal(after.issues.length, 2, 'Kontinuitäts-Issue + Faktenfehler');
  const ff = after.issues.find(i => i.typ === 'faktenfehler');
  assert.ok(ff);
  assert.equal(ff.quelle, 'https://example.org/apollo11');
  assert.ok(after.issues.some(i => i.typ === 'figur'), 'Kontinuitäts-Issue erhalten');
});

test('saveFaktencheckIssues: idempotent — ersetzt frühere faktenfehler', () => {
  setFlag(true);
  saveContinuityCheck(BOOK, EMAIL, 'S', 'm', [{ schwere: 'mittel', typ: 'ort', beschreibung: 'x', stelle_a: 'A', stelle_b: 'B', figuren: [], kapitel: [] }], {}, {});
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ schwere: 'mittel', typ: 'faktenfehler', beschreibung: `f${i}`, stelle_a: `s${i}`, stelle_b: '', quelle: `https://x/${i}`, figuren: [], kapitel: [] }));
  saveFaktencheckIssues(BOOK, EMAIL, 'm', mk(3), {}, {});
  saveFaktencheckIssues(BOOK, EMAIL, 'm', mk(2), {}, {}); // zweiter Lauf ersetzt
  const res = getLatestContinuityCheck(BOOK, EMAIL);
  assert.equal(res.issues.filter(i => i.typ === 'faktenfehler').length, 2);
  assert.equal(res.issues.filter(i => i.typ === 'ort').length, 1, 'Nicht-faktenfehler unberührt');
});

test('saveFaktencheckIssues: legt Check an, wenn keiner existiert', () => {
  setFlag(true);
  assert.equal(getLatestContinuityCheck(BOOK, EMAIL), null);
  saveFaktencheckIssues(BOOK, EMAIL, 'm',
    [{ schwere: 'niedrig', typ: 'faktenfehler', beschreibung: 'x', stelle_a: 's', stelle_b: '', quelle: 'https://x/1', figuren: [], kapitel: [] }],
    {}, {}, '__i18n:kontinuitaet.faktencheck.summaryFound__');
  const res = getLatestContinuityCheck(BOOK, EMAIL);
  assert.ok(res);
  assert.equal(res.issues.length, 1);
  assert.equal(res.summary, '__i18n:kontinuitaet.faktencheck.summaryFound__');
});

// ── Judge: abgeschnittenes Urteil ───────────────────────────────────────────
// parseJSON repariert tolerant — ein am max_tokens-Deckel abgeschnittenes Urteil
// muss darum VOR dem Parsen verworfen werden, sonst würde aus dem Rumpf ein
// scheinbar vollständiges „falsch"-Urteil.

test('_judgeOneFact: truncated → wirft job.error.aiTruncated statt Teil-Urteil', async () => {
  const { _judgeOneFact } = require('../../routes/jobs/komplett/job-faktencheck');
  const tok = { in: 0, out: 0 };
  const stub = async () => ({
    text: '{"urteil":"falsch","quelle":"https://example.org/x","beschreibung":"Die Mondl',
    truncated: true, stopReason: 'max_tokens', tokensIn: 100, tokensOut: 4000,
  });
  await assert.rejects(
    () => _judgeOneFact(tok, 'prompt', 'system', null, stub),
    (e) => e.message === 'job.error.aiTruncated' && e.i18nParams?.tokOut === 4000,
  );
  assert.equal(tok.out, 4000, 'Tokens werden trotzdem verbucht');
});

test('_judgeOneFact: pause_turn wird fortgesetzt, vollständiges Urteil kommt durch', async () => {
  const { _judgeOneFact } = require('../../routes/jobs/komplett/job-faktencheck');
  const tok = { in: 0, out: 0 };
  let calls = 0;
  const stub = async () => {
    calls++;
    if (calls === 1) return { text: '', stopReason: 'pause_turn', rawContentBlocks: [], tokensIn: 1, tokensOut: 1 };
    return { text: '{"urteil":"korrekt"}', stopReason: 'end_turn', tokensIn: 1, tokensOut: 1 };
  };
  const text = await _judgeOneFact(tok, 'prompt', 'system', null, stub);
  assert.equal(calls, 2);
  assert.equal(text, '{"urteil":"korrekt"}');
});

test('_judgeOneFact: auch nach der letzten Runde noch pause_turn → wirft statt leerem Urteil', async () => {
  const { _judgeOneFact } = require('../../routes/jobs/komplett/job-faktencheck');
  const tok = { in: 0, out: 0 };
  const stub = async () => ({ text: 'Ich suche noch …', stopReason: 'pause_turn', rawContentBlocks: [], tokensIn: 1, tokensOut: 1 });
  await assert.rejects(() => _judgeOneFact(tok, 'prompt', 'system', null, stub),
    (e) => e.message === 'job.error.factcheckVerdictInvalid');
});

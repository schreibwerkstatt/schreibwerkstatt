// Unit: Entscheide des Autors an Welt-Fakten überdauern die nächste Analyse.
//
// - Löschen einer Analyse-Aussage unterdrückt sie (world_fact_suppressions).
// - Umformulieren unterdrückt das Original und lenkt dessen Fundstellen auf den Ersatz.
// - Umformulierungen DER ANALYSE erkennt der Embedding-Abgleich (world-facts-match.js),
//   nur unter gleichem Subjekt; ohne Backend bleibt der exakte Schlüssel.
// - Vom Autor gesetzte Kapitel-Bezüge (manual = 1) bleiben beim Neubau der Brücken.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('wf-suppress');
const schema = require('../../db/schema');
const edit = require('../../db/world-facts-edit');
const embed = require('../../lib/embed');
const { matchFactAnchors, _pairs } = require('../../routes/jobs/komplett/world-facts-match');
const db = schema.db;
const { factKey } = require('../../lib/world-fact-key');

const BOOK = 720;
const USER = 'wfsup@test.dev';
const CH = { 'Kapitel 1': 7201, 'Kapitel 2': 7202 };

function setup() {
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(USER);
  schema.upsertBookByName(BOOK, 'Turm-Buch');
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)').run(7201, BOOK, 'Kapitel 1', 1);
  db.prepare('INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (?, ?, ?, ?)').run(7202, BOOK, 'Kapitel 2', 2);
  db.prepare('DELETE FROM world_facts WHERE book_id = ?').run(BOOK);
  db.prepare('DELETE FROM world_fact_suppressions WHERE book_id = ?').run(BOOK);
}

const run = (fakten, opts) => schema.saveFaktenToDb(BOOK, fakten, USER, CH, opts);
const rows = () => db.prepare('SELECT id, subjekt, fakt, manually_edited FROM world_facts WHERE book_id = ? ORDER BY id').all(BOOK);
const chaptersOf = (id) => db.prepare('SELECT chapter_id, manual FROM world_fact_chapters WHERE fact_id = ? ORDER BY chapter_id').all(id);

const TURM_9 = { kategorie: 'ort', subjekt: 'Turm', fakt: 'Der Turm hat neun Stockwerke' };
const BRUNNEN = { kategorie: 'ort', subjekt: 'Brunnen', fakt: 'Der Brunnen ist versiegt' };

test('Löschen einer Analyse-Aussage: der nächste Lauf legt sie nicht wieder an', () => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9, BRUNNEN] }]);
  const turm = rows().find(r => r.subjekt === 'Turm');
  edit.deleteWorldFact(BOOK, USER, turm.id);
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9, BRUNNEN] }]);
  assert.deepEqual(rows().map(r => r.subjekt), ['Brunnen']);
  assert.equal(schema.listFactSuppressions(BOOK, USER).length, 1);
});

test('Wiederherstellen hebt die Unterdrückung auf', () => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  edit.deleteWorldFact(BOOK, USER, rows()[0].id);
  const [sup] = schema.listFactSuppressions(BOOK, USER);
  edit.restoreSuppressedFact(BOOK, USER, sup.id);
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  assert.equal(rows().length, 1);
  assert.throws(() => edit.restoreSuppressedFact(BOOK, USER, sup.id), e => e.code === 'NOT_FOUND');
});

test('Korrektur: das Original ist unterdrückt, seine Fundstellen landen am Ersatz', () => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  const id = rows()[0].id;
  edit.updateWorldFact(BOOK, USER, id, { fakt: 'Der Turm hat sieben Stockwerke' });
  run([{ kapitel: 'Kapitel 2', fakten: [TURM_9] }]);
  const r = rows();
  assert.equal(r.length, 1, 'keine zweite Zeile mit dem Original');
  assert.equal(r[0].fakt, 'Der Turm hat sieben Stockwerke');
  assert.deepEqual(chaptersOf(id).map(c => c.chapter_id), [7202]);
});

test('Gepflegten Fakt wieder ändern legt keine zweite Unterdrückung an', () => {
  setup();
  const id = edit.createWorldFact(BOOK, USER, { fakt: 'Die Stadt hat zwei Tore', subjekt: 'Stadt', kategorie: 'ort' });
  edit.updateWorldFact(BOOK, USER, id, { fakt: 'Die Stadt hat drei Tore' });
  assert.equal(schema.listFactSuppressions(BOOK, USER).length, 0);
});

test('Ersatz gelöscht: die Aussage bleibt unterdrückt (SET NULL), kommt nicht zurück', () => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  const id = rows()[0].id;
  edit.updateWorldFact(BOOK, USER, id, { fakt: 'Der Turm hat sieben Stockwerke' });
  edit.deleteWorldFact(BOOK, USER, id);
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  assert.equal(rows().length, 0);
  assert.equal(schema.listFactSuppressions(BOOK, USER)[0].replaced_by, null);
});

test('Manueller Kapitel-Bezug überdauert die Analyse, Analyse-Brücken werden neu gebaut', () => {
  setup();
  const id = edit.createWorldFact(BOOK, USER, { ...TURM_9, chapter_ids: [7201] });
  run([{ kapitel: 'Kapitel 2', fakten: [TURM_9] }]);
  assert.deepEqual(chaptersOf(id), [{ chapter_id: 7201, manual: 1 }, { chapter_id: 7202, manual: 0 }]);
  run([{ kapitel: 'Kapitel 1', fakten: [] }]);
  assert.deepEqual(chaptersOf(id), [{ chapter_id: 7201, manual: 1 }]);
  assert.throws(() => edit.updateWorldFact(BOOK, USER, id, { chapter_ids: [999999] }), e => e.code === 'INVALID_CHAPTER_IDS');
});

test('matches aus dem Abgleich: Umformulierung legt nichts an bzw. geht an den Ersatz', () => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  const id = rows()[0].id;
  edit.updateWorldFact(BOOK, USER, id, { fakt: 'Der Turm hat sieben Stockwerke' });
  const para = { kategorie: 'ort', subjekt: 'Turm', fakt: 'Der Turm ist neun Stockwerke hoch' };
  const key = factKey(para.subjekt, para.fakt);
  run([{ kapitel: 'Kapitel 2', fakten: [para] }], { matches: new Map([[key, { target: id, score: 0.9 }]]) });
  assert.equal(rows().length, 1);
  assert.deepEqual(chaptersOf(id).map(c => c.chapter_id), [7202]);
});

test('_pairs: nur Aussagen mit dem Subjekt eines Ankers, ohne exakte Treffer', () => {
  const anchors = [{ key: factKey('Turm', 'Der Turm hat neun Stockwerke'), subjekt: 'Turm', fakt: 'Der Turm hat neun Stockwerke', target: null }];
  const { cands } = _pairs(anchors, [{ kapitel: 'K', fakten: [TURM_9, BRUNNEN, { subjekt: ' turm ', fakt: 'Der Turm ist neun Stockwerke hoch' }] }]);
  assert.deepEqual(cands.map(c => c.text), ['turm: Der Turm ist neun Stockwerke hoch']);
});

test('matchFactAnchors: Schwelle entscheidet; ohne Backend leere Map', async (t) => {
  setup();
  run([{ kapitel: 'Kapitel 1', fakten: [TURM_9] }]);
  edit.deleteWorldFact(BOOK, USER, rows()[0].id);
  const fakten = [{ kapitel: 'Kapitel 1', fakten: [
    { subjekt: 'Turm', fakt: 'Der Turm ist neun Stockwerke hoch' },
    { subjekt: 'Turm', fakt: 'Im Turm wohnt eine Eule' },
  ] }];
  t.mock.method(embed, 'isEnabled', () => false);
  assert.equal((await matchFactAnchors(BOOK, USER, fakten)).size, 0);
  t.mock.method(embed, 'isEnabled', () => true);
  // Anker zuerst, dann die Kandidaten in Eingabereihenfolge.
  t.mock.method(embed, 'embedBatch', async (texts) => texts.map(x =>
    x.includes('Eule') ? Float32Array.from([0, 1]) : x.includes('hoch') ? Float32Array.from([0.95, 0.31]) : Float32Array.from([1, 0])));
  const m = await matchFactAnchors(BOOK, USER, fakten);
  assert.deepEqual([...m.keys()], [factKey('Turm', 'Der Turm ist neun Stockwerke hoch')]);
  assert.equal([...m.values()][0].target, null);
  t.mock.method(embed, 'embedBatch', async () => { throw new Error('Backend weg'); });
  assert.equal((await matchFactAnchors(BOOK, USER, fakten)).size, 0, 'Fehler → nur exakter Schlüssel');
});

// Ideen, Gegenrichtung in die anderen Features:
//   · neue Ziel-Arten `draft` (Werkstatt-Figur) und `thread` (Strang) inkl. Buch-Prüfung
//   · list_ideen liefert `verknuepft`
//   · ideaNotesByTarget: offen/in Arbeit + verworfen, erledigt raus
//   · Plot-Prompts + Plot-Chat-Outline zeigen die Pendenzen am Beat/Strang
//   · Kapitelbewertung: offene Kapitel-Ideen als eigener Block
//   · Buchübersicht: Tile-Aggregat

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ideen-cross-feature');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const ideenDb = require('../../db/ideen');
const draftFigures = require('../../db/draft-figures');
const { db } = require('../../db/connection');
const { tool_list_ideen } = require('../../routes/jobs/book-chat-tools/tools-catalog');
const { ideaNotesByTarget } = require('../../lib/idea-context');
const { loadChapterIdeenContext } = require('../../routes/jobs/review-context');
const { loadBoardState, boardOutline } = require('../../routes/jobs/plot-chat-context');
const plotPrompts = await import('../../public/js/prompts/plot.js');
const { _buildIdeenContextBlock } = await import('../../public/js/prompts/review/context.js');
const { buildChapterReviewPrompt } = await import('../../public/js/prompts/review/builders.js');
const { ideenTileStats } = await import('../../public/js/book-overview/ideen.js');

const USER = 'ideen-x@x.test';
const OTHER = 'ideen-fremd@x.test';
let bookSeq = 773100;
appUsers.createUser({ email: USER, displayName: 'I' });
appUsers.createUser({ email: OTHER, displayName: 'F' });

function freshBook() {
  const id = ++bookSeq;
  schema.upsertBookByName(id, `Buch ${id}`);
  return id;
}
const idee = (B, content, extra = {}) => {
  const id = ideenDb.createIdee({ bookId: B, userEmail: USER, content, ...extra });
  return Number(id);
};
const setStatus = (id, status) => ideenDb.updateIdee(id, USER, { status });

test('idea_links: draft und thread als Ziele, Buch-Prüfung, Picker-Kataloge', () => {
  const B = freshBook();
  const other = freshBook();
  const d = draftFigures.createDraftFigure(B, USER, { name: 'Anna', mindmap: { topic: 'Anna' } });
  const t = plot.createThread(B, USER, { name: 'B-Story' });
  const tFremd = plot.createThread(other, USER, { name: 'Anderes Buch' });
  const i = idee(B, 'Bogen klären');

  assert.deepEqual(ideenDb.addIdeaLink(i, B, 'draft', d.id), { ok: true });
  assert.deepEqual(ideenDb.addIdeaLink(i, B, 'thread', t.id), { ok: true });
  assert.equal(ideenDb.addIdeaLink(i, B, 'thread', tFremd.id).error_code, 'BOOK_MISMATCH');
  const row = ideenDb.getIdee(i);
  assert.deepEqual(row.links.map(l => [l.target_kind, l.label]).sort(), [['draft', 'Anna'], ['thread', 'B-Story']]);

  const targets = ideenDb.listIdeaLinkTargets(B, USER);
  assert.deepEqual(targets.draft.map(x => x.label), ['Anna']);
  assert.deepEqual(targets.thread.map(x => x.label), ['B-Story']);
  assert.deepEqual(ideenDb.listIdeaLinkTargets(B, OTHER).draft, []);

  // Löschen der Gegenseite nimmt nur die Kante mit, die Idee bleibt.
  plot.deleteThread(t.id);
  assert.deepEqual(ideenDb.getIdee(i).links.map(l => l.target_kind), ['draft']);
});

test('list_ideen: verknuepft nur bei vorhandenen Kanten', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const beat = plot.createBeat(B, a.id, USER, { titel: 'Showdown' });
  const mit = idee(B, 'Motivation unklar');
  idee(B, 'ohne Kante');
  ideenDb.addIdeaLink(mit, B, 'beat', beat.id);
  const res = tool_list_ideen({}, { bookId: B, userEmail: USER });
  const byContent = Object.fromEntries(res.ideen.map(x => [x.content, x]));
  assert.deepEqual(byContent['Motivation unklar'].verknuepft, [{ art: 'beat', id: beat.id, label: 'Showdown' }]);
  assert.equal('verknuepft' in byContent['ohne Kante'], false);
});

test('ideaNotesByTarget: offen + verworfen, erledigt raus, offene zuerst, user-privat', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const beat = plot.createBeat(B, a.id, USER, { titel: 'X' });
  const v = idee(B, 'Zwillingsbruder');      setStatus(v, 'verworfen');
  const e = idee(B, 'schon umgesetzt');      setStatus(e, 'erledigt');
  const o = idee(B, 'Motivation schärfen');
  for (const id of [v, e, o]) ideenDb.addIdeaLink(id, B, 'beat', beat.id);

  const notes = ideaNotesByTarget('beat', B, USER).get(beat.id);
  assert.deepEqual(notes.map(n => [n.content, n.status]), [['Motivation schärfen', 'offen'], ['Zwillingsbruder', 'verworfen']]);
  assert.equal(ideaNotesByTarget('beat', B, OTHER).size, 0);
});

test('Plot-Prompts: Pendenzen am Beat und Strang, selbsterklärend gekennzeichnet', () => {
  const ideen = [{ content: 'Motivation schärfen', status: 'offen' }, { content: 'Zwillingsbruder', status: 'verworfen' }];
  const marker = plotPrompts.ideenMarker(ideen);
  assert.match(marker, /offene Pendenz des Autors \(ihm bekannt, nicht als neuen Befund melden\): «Motivation schärfen»/);
  assert.match(marker, /VERWORFEN \(nicht erneut vorschlagen\): «Zwillingsbruder»/);
  assert.equal(plotPrompts.ideenMarker([]), '');

  const acts = [{ id: 1, name: 'Akt 1', position: 0 }];
  const threads = [{ id: 7, name: 'B-Story', ideen: [{ content: 'Wendepunkt fehlt', status: 'offen' }] }];
  const beats = [{ id: 3, act_id: 1, titel: 'Showdown', status: 'geplant', sort_order: 0, ideen }];
  const out = plotPrompts.buildPlotBrainstormPrompt(1, acts, beats, '', [], [], [], threads);
  assert.ok(out.includes(marker));
  assert.ok(out.includes('«Wendepunkt fehlt»'));
});

test('Plot-Chat-Outline: Pendenzen an Beat und Strang über die Facade-Form', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const t = plot.createThread(B, USER, { name: 'B-Story' });
  const beat = plot.createBeat(B, a.id, USER, { titel: 'Showdown' });
  const i1 = idee(B, 'Motivation schärfen');
  const i2 = idee(B, 'Wendepunkt fehlt');
  ideenDb.addIdeaLink(i1, B, 'beat', beat.id);
  ideenDb.addIdeaLink(i2, B, 'thread', t.id);
  const state = loadBoardState(B, USER);
  const text = boardOutline(state, { ideenMarker: plotPrompts.ideenMarker });
  assert.ok(text.includes('«Motivation schärfen»'));
  assert.ok(text.includes('«Wendepunkt fehlt»'));
  assert.doesNotMatch(boardOutline(state), /Pendenz/);
});

test('Kapitelbewertung: offene Ideen an Kapitel und Seiten, Block mit Rahmung', () => {
  const B = freshBook();
  const k = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(B, 'Eins').lastInsertRowid;
  db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, updated_at) VALUES (?, ?, ?, 'S1', '2026-01-01T00:00:00.000Z')`).run(B * 10, B, k);
  idee(B, 'Zeitangabe prüfen', { chapterId: k });
  idee(B, 'Beleg nachtragen', { pageId: B * 10 });
  const done = idee(B, 'erledigt', { chapterId: k }); setStatus(done, 'erledigt');
  idee(B, 'Buch-Idee ohne Ort');

  const ctx = loadChapterIdeenContext(B, USER, [k]);
  assert.deepEqual(ctx.ideen.map(i => [i.ort, i.content]).sort(),
    [['Kapitel', 'Zeitangabe prüfen'], ['Seite «S1»', 'Beleg nachtragen']]);
  assert.equal(loadChapterIdeenContext(B, OTHER, [k]), null);

  const block = _buildIdeenContextBlock(ctx);
  assert.match(block, /Wiederhole sie NICHT als neue\nEmpfehlung/);
  assert.match(block, /Beeinflussen sie die Note nicht/);
  assert.ok(buildChapterReviewPrompt('K', 'B', 1, 'Text', { ideenContext: ctx }).includes('OFFENE PENDENZEN'));
  assert.equal(_buildIdeenContextBlock(null), '');
});

test('Buchübersicht: Tile-Aggregat', () => {
  const s = ideenTileStats([
    { status: 'offen', page_id: null, chapter_id: null, links: [{}] },
    { status: 'in_arbeit', page_id: 1, chapter_id: null, links: [] },
    { status: 'erledigt', page_id: null, chapter_id: null, links: [{}] },
    { status: 'verworfen', page_id: 2, chapter_id: null },
  ]);
  assert.deepEqual(s, { total: 4, open: 2, by: { offen: 1, in_arbeit: 1, erledigt: 1, verworfen: 1 }, ohneOrt: 1, verknuepft: 1 });
});

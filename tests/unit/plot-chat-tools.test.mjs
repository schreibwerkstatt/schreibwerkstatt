// Plot-Chat: Vorschlags-Werkzeuge (routes/jobs/plot-chat-tools.js) + Board-Kontext
// (routes/jobs/plot-chat-context.js) gegen eine Wegwerf-DB.
//  - propose_* validieren gegen den Board-Stand und sammeln in ctx.proposals,
//    schreiben aber NICHTS (der User übernimmt jeden Vorschlag einzeln).
//  - Fehlerhafte Aufrufe kommen als { error } zurück (Modell korrigiert).
//  - act_ref/thread_ref verweisen auf Vorschläge derselben Antwort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('plot-chat-tools');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const draftFigures = require('../../db/draft-figures');
const { db } = require('../../db/connection');
const { executePlotChatTool, MAX_PROPOSALS } = require('../../routes/jobs/plot-chat-tools');
const { loadBoardState, boardOutline, figurenOutline, sessionPlotProposalMemory } = require('../../routes/jobs/plot-chat-context');

const USER = 'plotchat@x.test';
const BOOK = 770101;
const CHAPTER_ID = 880101;

appUsers.createUser({ email: USER, displayName: 'Plot Chat' });
schema.upsertBookByName(BOOK, 'Plot-Chat-Testbuch');
db.prepare(
  `INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
   VALUES (?, ?, 'fig_anna', 'Anna Berger', 'Anna', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
).run(BOOK, USER);
const draft = draftFigures.createDraftFigure(BOOK, USER, { name: 'Der Fremde', mindmap: { root: { children: [] } } });

const act1 = plot.createAct(BOOK, USER, { name: 'Aufbruch' });
const act2 = plot.createAct(BOOK, USER, { name: 'Konfrontation' });
const thread = plot.createThread(BOOK, USER, { name: 'Annas Weg' });
const ownAct = plot.createAct(BOOK, USER, { name: 'Annas eigener Akt', threadId: thread.id });
const beatA = plot.createBeat(BOOK, act1.id, USER, { titel: 'Brief kommt an', beschreibung: 'Anna liest den Brief' });
const beatB = plot.createBeat(BOOK, act1.id, USER, { titel: 'Abschied', figureIds: plot.resolveFigureIds(BOOK, USER, ['fig_anna']) });

const chapterNames = new Map([[CHAPTER_ID, 'Teil 1 › Kapitel 1']]);
const beatCount = () => db.prepare('SELECT COUNT(*) AS n FROM plot_beats WHERE book_id = ?').get(BOOK).n;
const mkCtx = () => ({
  bookId: BOOK, userEmail: USER, proposals: [], chapterNames,
  offeredTools: new Set(['get_plot_board']), logger: { info() {}, warn() {} },
});

test('propose_beat: neuer Beat wird gesammelt, nicht geschrieben', async () => {
  const ctx = mkCtx();
  const before = beatCount();
  const out = await executePlotChatTool('propose_beat', {
    act_id: act2.id, titel: 'Der Verrat', beschreibung: '- Ben verrät Anna', intensitaet: 4,
    chapter_id: CHAPTER_ID, figuren: ['Anna', 'Der Fremde'], after_beat_id: null, begruendung: 'Wendepunkt',
  }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.ref, 1);
  assert.equal(beatCount(), before);
  const p = ctx.proposals[0];
  assert.equal(p.type, 'beat_create');
  assert.equal(p.act_id, act2.id);
  assert.equal(p.thread_id, null);
  assert.deepEqual(p.fields.figure_ids, ['fig_anna']);
  assert.deepEqual(p.fields.draft_figure_ids, [draft.id]);
  assert.equal(p.fields.chapter_id, CHAPTER_ID);
  assert.equal(p.labels.act, 'Konfrontation');
  assert.equal(p.labels.chapter, 'Teil 1 › Kapitel 1');
  assert.equal(p.begruendung, 'Wendepunkt');
});

test('propose_beat: unbekannte Figur, fremdes Kapitel, fehlender Akt → error', async () => {
  const ctx = mkCtx();
  assert.match((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'X', figuren: ['Niemand'], begruendung: 'b' }, ctx)).error, /Niemand/);
  assert.ok((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'X', chapter_id: 1, begruendung: 'b' }, ctx)).error);
  assert.ok((await executePlotChatTool('propose_beat', { titel: 'X', begruendung: 'b' }, ctx)).error);
  assert.ok((await executePlotChatTool('propose_beat', { act_id: 999999, titel: 'X', begruendung: 'b' }, ctx)).error);
  assert.equal(ctx.proposals.length, 0);
});

test('propose_beat: Hybrid-Akt verlangt den eigenen Strang', async () => {
  const ctx = mkCtx();
  const bad = await executePlotChatTool('propose_beat', { act_id: ownAct.id, titel: 'X', begruendung: 'b' }, ctx);
  assert.ok(bad.error);
  const ok = await executePlotChatTool('propose_beat', { act_id: ownAct.id, thread_id: thread.id, titel: 'X', begruendung: 'b' }, ctx);
  assert.equal(ok.ok, true);
});

test('propose_beat: after_beat_id muss in der Zielzelle liegen', async () => {
  const ctx = mkCtx();
  assert.ok((await executePlotChatTool('propose_beat', { act_id: act2.id, after_beat_id: beatA.id, titel: 'X', begruendung: 'b' }, ctx)).error);
  const ok = await executePlotChatTool('propose_beat', { act_id: act1.id, after_beat_id: beatA.id, titel: 'X', begruendung: 'b' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(ctx.proposals[0].after_beat_id, beatA.id);
  assert.equal(ctx.proposals[0].labels.after, 'Brief kommt an');
});

test('propose_beat mit beat_id: nur geänderte Felder + Vorher-Werte; No-Op → error', async () => {
  const ctx = mkCtx();
  const out = await executePlotChatTool('propose_beat', {
    beat_id: beatA.id, titel: 'Der Brief', beschreibung: 'Anna liest den Brief', begruendung: 'präziser',
  }, ctx);
  assert.equal(out.ok, true);
  const p = ctx.proposals[0];
  assert.equal(p.type, 'beat_update');
  assert.deepEqual(p.fields, { titel: 'Der Brief' });
  assert.deepEqual(p.before, { titel: 'Brief kommt an' });
  const noop = await executePlotChatTool('propose_beat', { beat_id: beatA.id, titel: 'Brief kommt an', begruendung: 'b' }, ctx);
  assert.ok(noop.error);
  const move = await executePlotChatTool('propose_beat', { beat_id: beatA.id, act_id: act2.id, begruendung: 'b' }, ctx);
  assert.match(move.error, /propose_beat_move/);
});

test('propose_beat mit beat_id: verworfen + Figurenwechsel mit Anzeige-Namen', async () => {
  const ctx = mkCtx();
  const out = await executePlotChatTool('propose_beat', { beat_id: beatB.id, verworfen: true, figuren: ['Der Fremde'], begruendung: 'b' }, ctx);
  assert.equal(out.ok, true);
  const p = ctx.proposals[0];
  assert.equal(p.fields.verworfen, 1);
  assert.deepEqual(p.fields.figure_ids, []);
  assert.deepEqual(p.fields.draft_figure_ids, [draft.id]);
  assert.deepEqual(p.labels.figuren_before, ['Anna Berger']);
  assert.deepEqual(p.labels.figuren, ['Der Fremde']);
});

test('propose_beat_move: Ziel-Akt + Position; ohne Bewegung → error', async () => {
  const ctx = mkCtx();
  const out = await executePlotChatTool('propose_beat_move', { beat_id: beatB.id, act_id: act2.id, begruendung: 'b' }, ctx);
  assert.equal(out.ok, true);
  const p = ctx.proposals[0];
  assert.equal(p.type, 'beat_move');
  assert.deepEqual(p.before, { act_id: act1.id, thread_id: null });
  assert.equal(p.labels.from_act, 'Aufbruch');
  assert.equal(p.labels.act, 'Konfrontation');
  const none = await executePlotChatTool('propose_beat_move', { beat_id: beatB.id, begruendung: 'b' }, ctx);
  assert.ok(none.error);
  const reorder = await executePlotChatTool('propose_beat_move', { beat_id: beatB.id, at_start: true, begruendung: 'b' }, ctx);
  assert.equal(reorder.ok, true);
});

test('act_ref/thread_ref: neuer Akt + Strang, Beat verweist darauf', async () => {
  const ctx = mkCtx();
  const t = await executePlotChatTool('propose_thread', { name: 'Bens Weg', figur: 'Der Fremde', begruendung: 'zweite Perspektive' }, ctx);
  const a = await executePlotChatTool('propose_act', { name: 'Auflösung', after_act_id: act2.id, begruendung: 'fehlt' }, ctx);
  const b = await executePlotChatTool('propose_beat', { act_ref: a.ref, thread_ref: t.ref, titel: 'Showdown', begruendung: 'Klimax' }, ctx);
  assert.equal(b.ok, true);
  const [pt, pa, pb] = ctx.proposals;
  assert.equal(pt.type, 'thread_create');
  assert.equal(pt.draft_figure_id, draft.id);
  assert.equal(pa.type, 'act_create');
  assert.equal(pa.after_act_id, act2.id);
  assert.equal(pb.act_ref, 2);
  assert.equal(pb.thread_ref, 1);
  assert.equal(pb.labels.act, 'Auflösung');
  // Falsche Referenz-Art
  assert.ok((await executePlotChatTool('propose_beat', { act_ref: t.ref, titel: 'X', begruendung: 'b' }, ctx)).error);
});

test('propose_act/propose_thread: Umbenennung mit Vorher-Wert, gleicher Name → error', async () => {
  const ctx = mkCtx();
  assert.equal((await executePlotChatTool('propose_act', { act_id: act1.id, name: 'Der Ruf', begruendung: 'b' }, ctx)).ok, true);
  assert.deepEqual(ctx.proposals[0].before, { name: 'Aufbruch' });
  assert.ok((await executePlotChatTool('propose_act', { act_id: act1.id, name: 'Aufbruch', begruendung: 'b' }, ctx)).error);
  assert.equal((await executePlotChatTool('propose_thread', { thread_id: thread.id, name: 'Annas Weg', figur: 'Anna', begruendung: 'b' }, ctx)).ok, true);
  const pt = ctx.proposals[1];
  assert.equal(pt.type, 'thread_update');
  assert.equal(pt.fields.figure_id, 'fig_anna');
  assert.equal(pt.fields.name, undefined);
});

test('Deckel: höchstens MAX_PROPOSALS Vorschläge pro Antwort', async () => {
  const ctx = mkCtx();
  for (let i = 0; i < MAX_PROPOSALS; i++) {
    assert.equal((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: `B${i}`, begruendung: 'b' }, ctx)).ok, true);
  }
  assert.ok((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'zu viel', begruendung: 'b' }, ctx)).error);
});

test('Lese-Werkzeug ausserhalb der angebotenen Liste wirft', async () => {
  await assert.rejects(() => executePlotChatTool('generate_image', {}, mkCtx()), /Unbekanntes Werkzeug/);
});

test('boardOutline: Akte, Strang-eigene Akte, Beats mit [#id] und Figuren', () => {
  const state = loadBoardState(BOOK, USER, chapterNames);
  const text = boardOutline(state);
  assert.match(text, new RegExp(`STRÄNGE:\\n- \\[#${thread.id}\\] «Annas Weg»`));
  assert.match(text, new RegExp(`AKT \\[#${act1.id}\\] «Aufbruch» \\(geteilt\\)`));
  assert.match(text, new RegExp(`AKT \\[#${ownAct.id}\\] «Annas eigener Akt» \\(nur Strang «Annas Weg»`));
  assert.match(text, new RegExp(`\\[#${beatB.id}\\] «Abschied» · geplant · Figuren: Anna Berger`));
  // Geteilte Akte vor den strang-eigenen, Reihenfolge = Board-Reihenfolge.
  assert.ok(text.indexOf('«Aufbruch»') < text.indexOf('«Konfrontation»'));
  assert.ok(text.indexOf('«Konfrontation»') < text.indexOf('«Annas eigener Akt»'));
  const figs = figurenOutline(state);
  assert.match(figs, /Anna Berger \(Anna\) · fig_id fig_anna/);
  assert.match(figs, /Der Fremde · Werkstatt-Figur/);
});

test('sessionPlotProposalMemory: Status übernommen/verworfen/offen', () => {
  const now = new Date().toISOString();
  const sid = db.prepare(
    `INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'plot', ?, ?, ?)`
  ).run(BOOK, USER, now, now).lastInsertRowid;
  const proposals = [
    { type: 'beat_create', fields: { titel: 'A' }, applied_at: now, applied_id: 1 },
    { type: 'act_create', name: 'B', status: 'discarded' },
    { type: 'beat_move', labels: { beat: 'C' } },
  ];
  db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'x', ?, ?)`
  ).run(sid, JSON.stringify({ proposals }), now);
  const mem = sessionPlotProposalMemory(sid);
  assert.deepEqual(mem.map(m => [m.label, m.state]), [['A', 'applied'], ['B', 'discarded'], ['C', 'open']]);
});

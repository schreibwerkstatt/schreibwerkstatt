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

test('leeren: Kapitel vom Beat lösen und andere Felder leeren; leere Strings ändern nichts', async () => {
  const beatK = plot.createBeat(BOOK, act2.id, USER, { titel: 'Mit Kapitel', beschreibung: 'Text', zeit: 'Sommer', intensitaet: 3 });
  db.prepare('UPDATE plot_beats SET chapter_id = ? WHERE id = ?').run(null, beatK.id);
  // Kapitel per DB setzen (Testbuch hat das Kapitel nur in der Namens-Map).
  const ctx = mkCtx();
  ctx._board = loadBoardState(BOOK, USER, chapterNames);
  ctx._board.beatById.get(beatK.id).chapter_id = CHAPTER_ID;
  const out = await executePlotChatTool('propose_beat', {
    beat_id: beatK.id, leeren: ['kapitel', 'zeit', 'intensitaet', 'beschreibung'], begruendung: 'gehört nirgends hin',
  }, ctx);
  assert.equal(out.ok, true, out.error);
  const p = ctx.proposals[0];
  assert.deepEqual(p.fields, { chapter_id: null, zeit: null, intensitaet: null, beschreibung: '' });
  assert.equal(p.before.chapter_id, CHAPTER_ID);
  assert.equal(p.labels.chapter_before, 'Teil 1 › Kapitel 1');
  // Leerer String = nicht angegeben (nicht «leeren»): No-Op.
  assert.match((await executePlotChatTool('propose_beat', { beat_id: beatK.id, beschreibung: '', zeit: '', begruendung: 'b' }, ctx)).error, /ändert/);
  // Leeren nur bei Änderungen, nur bekannte Felder, nicht zugleich setzen.
  assert.ok((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'X', leeren: ['zeit'], begruendung: 'b' }, ctx)).error);
  assert.ok((await executePlotChatTool('propose_beat', { beat_id: beatK.id, leeren: ['titel'], begruendung: 'b' }, ctx)).error);
  assert.ok((await executePlotChatTool('propose_beat', { beat_id: beatK.id, zeit: 'Winter', leeren: ['zeit'], begruendung: 'b' }, ctx)).error);
  // Bereits leere Felder leeren = No-Op.
  const beatEmpty = plot.createBeat(BOOK, act2.id, USER, { titel: 'Leer' });
  const ctx2 = mkCtx();
  assert.match((await executePlotChatTool('propose_beat', { beat_id: beatEmpty.id, leeren: ['kapitel', 'beschreibung'], begruendung: 'b' }, ctx2)).error, /ändert/);
});

test('Parität klassisch ↔ agentisch: gleiche Eingabe, gleicher Vorschlag', async () => {
  const { collectClassicProposals } = require('../../routes/jobs/plot-chat');
  const input = { beat_id: beatA.id, titel: '', beschreibung: '', intensitaet: 0, chapter_id: null, figuren: [], leeren: ['zeit'], zeit: '', begruendung: 'b' };
  const beatZ = plot.createBeat(BOOK, act1.id, USER, { titel: 'Mit Zeit', zeit: 'Herbst' });
  input.beat_id = beatZ.id;
  const { makeProposalChatJob } = require('../../routes/jobs/proposal-chat');
  assert.ok(makeProposalChatJob);
  const ctxA = mkCtx();
  const { cleanProposalInput } = require('../../routes/jobs/proposal-chat-shared');
  await executePlotChatTool('propose_beat', cleanProposalInput(input), ctxA);
  const ctxC = mkCtx();
  await collectClassicProposals([{ werkzeug: 'propose_beat', ...input }], ctxC, null);
  assert.equal(ctxA.proposals.length, 1);
  assert.deepEqual(ctxC.proposals, ctxA.proposals);
  assert.deepEqual(ctxA.proposals[0].fields, { zeit: null });
});

test('Neuer Strang + eigener Akt in einer Antwort (thread_ref) → fork; Beat darauf nur im neuen Strang', async () => {
  const ctx = mkCtx();
  const t = await executePlotChatTool('propose_thread', { name: 'Neue Linie', begruendung: 'b' }, ctx);
  const a = await executePlotChatTool('propose_act', { name: 'Eigener Auftakt', thread_ref: t.ref, begruendung: 'b' }, ctx);
  assert.equal(a.ok, true, a.error);
  const pa = ctx.proposals[1];
  assert.equal(pa.thread_ref, t.ref);
  assert.equal(pa.fork, true);
  assert.equal(pa.thread_id, undefined);
  assert.equal(pa.labels.thread, 'Neue Linie');
  const b = await executePlotChatTool('propose_beat', { act_ref: a.ref, thread_ref: t.ref, titel: 'Start', begruendung: 'b' }, ctx);
  assert.equal(b.ok, true, b.error);
  // Ohne Strang bzw. mit anderem Strang passt der strang-eigene Akt nicht.
  assert.ok((await executePlotChatTool('propose_beat', { act_ref: a.ref, titel: 'X', begruendung: 'b' }, ctx)).error);
  assert.ok((await executePlotChatTool('propose_beat', { act_ref: a.ref, thread_id: thread.id, titel: 'X', begruendung: 'b' }, ctx)).error);
  // Kein after_act_id bei fork (die Klone haben noch keine ids).
  assert.match((await executePlotChatTool('propose_act', { name: 'Y', thread_ref: t.ref, after_act_id: act1.id, begruendung: 'b' }, ctx)).error, /after_act_id/);
});

test('Akt für bestehenden Strang: ohne eigene Aktstruktur → fork, mit → ohne', async () => {
  const plain = plot.createThread(BOOK, USER, { name: 'Ohne eigene Akte' });
  const ctx = mkCtx();
  assert.equal((await executePlotChatTool('propose_act', { name: 'Neu A', thread_id: plain.id, begruendung: 'b' }, ctx)).ok, true);
  assert.equal(ctx.proposals[0].fork, true);
  assert.equal((await executePlotChatTool('propose_act', { name: 'Neu B', thread_id: thread.id, after_act_id: ownAct.id, begruendung: 'b' }, ctx)).ok, true);
  assert.equal(ctx.proposals[1].fork, undefined);
  // Hybrid-Regel: Strang mit eigener Aktstruktur nicht auf einem geteilten Akt.
  assert.ok((await executePlotChatTool('propose_beat', { act_id: act1.id, thread_id: thread.id, titel: 'X', begruendung: 'b' }, ctx)).error);
  assert.equal((await executePlotChatTool('propose_beat', { act_id: act1.id, thread_id: plain.id, titel: 'X', begruendung: 'b' }, ctx)).ok, true);
});

test('boardOutline: Blöcke der Lesereihenfolge, Beats je Akt nach Lane-Rang', () => {
  const lane2 = plot.createThread(BOOK, USER, { name: 'Zweite Lane' });
  const actL = plot.createAct(BOOK, USER, { name: 'Lane-Akt' });
  // Reihenfolge der Anlage: ohne Strang zuerst, dann Lane 2 — Lane-Rang dreht das.
  const bNone = plot.createBeat(BOOK, actL.id, USER, { titel: 'Ohne Strang' });
  const bLane = plot.createBeat(BOOK, actL.id, USER, { titel: 'In Lane 2', threadId: lane2.id });
  const state = loadBoardState(BOOK, USER, chapterNames);
  const text = boardOutline(state);
  assert.match(text, /=== GETEILTE AKTE — gemeinsame Lesereihenfolge/);
  assert.match(text, new RegExp(`=== STRANG «Annas Weg» \\[#${thread.id}\\] — EIGENE AKTSTRUKTUR`));
  assert.ok(text.indexOf('=== GETEILTE AKTE') < text.indexOf('«Aufbruch»'));
  assert.ok(text.indexOf('«Lane-Akt»') < text.indexOf('=== STRANG «Annas Weg»'), 'geteilte Akte im ersten Block');
  assert.ok(text.indexOf(`[#${bLane.id}]`) < text.indexOf(`[#${bNone.id}]`), '«ohne Strang» als letzte Lane');
});

test('fitBoardOutline: knappes Budget kürzt Beschreibungen und zählt verworfene Beats', () => {
  const { fitBoardOutline } = require('../../routes/jobs/plot-chat-context');
  const long = plot.createBeat(BOOK, act2.id, USER, { titel: 'Lang', beschreibung: 'x'.repeat(280) });
  const gone = plot.createBeat(BOOK, act2.id, USER, { titel: 'Ausgemustert' });
  plot.updateBeat(gone.id, { verworfen: 1 });
  const state = loadBoardState(BOOK, USER, chapterNames);
  const full = fitBoardOutline(state);
  assert.equal(full.trimmed, false);
  assert.match(full.text, /«Ausgemustert»/);
  const small = fitBoardOutline(state, { budgetChars: full.text.length - 1 });
  assert.equal(small.trimmed, true);
  assert.doesNotMatch(small.text, /«Ausgemustert»/);
  assert.match(small.text, /verworfene[r]? Beat/);
  assert.ok(!small.text.includes('x'.repeat(150)), 'Beschreibung gekürzt');
  assert.ok(small.text.includes(`[#${long.id}]`));
  const tiny = fitBoardOutline(state, { budgetChars: 200 });
  assert.match(tiny.text, /Board gekürzt/);
});

test('Gedächtnis: übernommener, danach rückgängig gemachter Beat steht als «removed»', () => {
  const now = new Date().toISOString();
  const sid = db.prepare(
    `INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'plot', ?, ?, ?)`
  ).run(BOOK, USER, now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'x', ?, ?)`
  ).run(sid, JSON.stringify({ proposals: [
    { type: 'beat_create', fields: { titel: 'Da' }, applied_at: now, applied_id: beatA.id },
    { type: 'beat_create', fields: { titel: 'Weg' }, applied_at: now, applied_id: 99999999 },
    { type: 'act_update', name: 'Umbenannt', applied_at: now, applied_id: act1.id },
  ] }), now);
  const state = loadBoardState(BOOK, USER, chapterNames);
  assert.deepEqual(sessionPlotProposalMemory(sid, state).map(m => m.state), ['applied', 'removed', 'applied']);
});

// Zuletzt: legt eine zweite Figur namens «Der Fremde» an (Katalog) — danach ist der Name mehrdeutig.
test('Figuren: Kennungen fig_id/draft#id, mehrdeutiger Name → Fehler statt erster Treffer', async () => {
  const ctx = mkCtx();
  assert.equal((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'Mit Kennung', figuren: [`draft#${draft.id}`, 'fig_anna'], begruendung: 'b' }, ctx)).ok, true);
  assert.deepEqual(ctx.proposals[0].fields.draft_figure_ids, [draft.id]);
  assert.deepEqual(ctx.proposals[0].fields.figure_ids, ['fig_anna']);
  assert.match((await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'X', figuren: ['draft#99999'], begruendung: 'b' }, ctx)).error, /Unbekannte/);
  const figs = figurenOutline(loadBoardState(BOOK, USER, chapterNames));
  assert.match(figs, new RegExp(`Der Fremde · Werkstatt-Figur draft#${draft.id}`));

  db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
     VALUES (?, ?, 'fig_fremd', 'Der Fremde', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(BOOK, USER);
  const ctx2 = mkCtx();
  const amb = await executePlotChatTool('propose_beat', { act_id: act1.id, titel: 'X', figuren: ['Der Fremde'], begruendung: 'b' }, ctx2);
  assert.match(amb.error, /Mehrdeutig/);
  assert.match(amb.error, /fig_id fig_fremd/);
  assert.match(amb.error, new RegExp(`draft#${draft.id}`));
  assert.match((await executePlotChatTool('propose_thread', { name: 'T', figur: 'der fremde', begruendung: 'b' }, ctx2)).error, /Mehrdeutig/);
  assert.equal((await executePlotChatTool('propose_thread', { name: 'T', figur: 'fig_fremd', begruendung: 'b' }, ctx2)).ok, true);
});

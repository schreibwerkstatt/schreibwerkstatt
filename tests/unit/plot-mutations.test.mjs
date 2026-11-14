// Plot-Werkstatt: Mutations-Invarianten der Board-Methoden ohne Alpine/DOM.
//   - mergeBeatRow: PATCH-Antwort ohne occ_count/occ_top kippt das Anker-Badge nicht
//   - beatFieldsEqual / saveEditBeat-Dirty-Check: unveränderter Draft → kein PATCH, kein Record
//   - startEditBeat committet einen offenen ANDEREN Beat, bevor der Draft wechselt
//   - _pruneBeatsLocal: Beats + Kanten + Edit/Permalink raus
//   - Undo/Redo setzt busy; Mutationen kehren währenddessen früh zurück
//   - Applier leert die Historie → Record wird nicht zurückgelegt
//   - moveAct / _hApplyActOrder rollen bei PUT-Fehler den Snapshot zurück
//   - Spannungsbogen: „ohne Strang" als eigene Serie
//   - relTargetTitle: Ziel-Titel live aus dem Board
//   - Beat-Löschen ist rückgängig machbar: Neuanlage aus dem Snapshot, ID-Remap, Redo löscht wieder
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBeatRow, beatFieldsEqual } from '../../public/js/book/plot/constants.js';
import { historyMethods } from '../../public/js/book/plot/history.js';
import { lifecycleMethods } from '../../public/js/book/plot/lifecycle.js';
import { boardMethods } from '../../public/js/book/plot/derived/board.js';
import { tensionMethods } from '../../public/js/book/plot/derived/tension.js';
import { beatsMethods } from '../../public/js/book/plot/beats.js';
import { actsMethods } from '../../public/js/book/plot/acts.js';
import { beatRestoreMethods } from '../../public/js/book/plot/beat-restore.js';

// Browser-Globals, die die Methoden direkt ansprechen.
const nav = { selectedBookId: 1, plotBeatId: null };
const Alpine = { store: (n) => (n === 'nav' ? nav : {}) };
globalThis.Alpine = Alpine;
globalThis.window = { Alpine, __app: { t: (k, p) => (p?.titel ? `${p.titel}!` : k), refreshPlotBeatCounts() {} } };

// fetch-Mock: Antworten pro Aufruf aus einer Queue, Aufrufe werden protokolliert.
let fetchLog = [];
let fetchQueue = [];
globalThis.fetch = async (url, opts = {}) => {
  fetchLog.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const next = fetchQueue.shift() || { ok: true, body: {} };
  return {
    ok: next.ok,
    status: next.ok ? 200 : 500,
    json: async () => next.body,
    clone() { return this; },
  };
};

function makeCtx(extra = {}) {
  fetchLog = []; fetchQueue = [];
  nav.plotBeatId = null;
  return {
    ...lifecycleMethods, ...boardMethods, ...tensionMethods, ...historyMethods, ...beatsMethods, ...actsMethods,
    ...beatRestoreMethods,
    acts: [], threads: [], beats: [], relations: [],
    busy: false, errorMessage: '', _memos: {},
    _undoStack: [], _redoStack: [], _inHistoryFlight: false, _historyEpoch: 0,
    editingBeatId: null, beatDraft: {}, relDraftTyp: 'x', relDraftTarget: '9',
    beatOccPopoverBeatId: null, _pendingFocusBeatId: null, plotShowArchived: false,
    loadTimeChecks() {}, loadBoard: async () => {}, $nextTick: (fn) => fn?.(),
    ...extra,
  };
}

test('mergeBeatRow erbt nur fehlende GET-only-Felder', () => {
  const cur = { id: 1, titel: 'alt', occ_count: 3, occ_top: [{ page_id: 4 }] };
  assert.deepEqual(mergeBeatRow(cur, { id: 1, titel: 'neu' }),
    { id: 1, titel: 'neu', occ_count: 3, occ_top: [{ page_id: 4 }] });
  // Liefert der Server die Felder künftig mit, gewinnt die Antwort.
  assert.equal(mergeBeatRow(cur, { id: 1, occ_count: 0, occ_top: [] }).occ_count, 0);
  assert.deepEqual(mergeBeatRow(null, { id: 2 }), { id: 2 });
});

test('_replaceBeat (alle PATCH-Pfade) behält occ_count/occ_top', () => {
  const ctx = makeCtx({ beats: [{ id: 1, status: 'geplant', occ_count: 2, occ_top: [{ page_id: 9 }] }] });
  ctx._replaceBeat({ id: 1, status: 'im_buch' });
  assert.equal(ctx.beats[0].status, 'im_buch');
  assert.equal(ctx.beats[0].occ_count, 2);
  assert.equal(ctx.beatAnchorState(ctx.beats[0]), 'confirmed');
});

test('beatFieldsEqual: Arrays als Mengen, leere Werte und ID-Typen tolerant', () => {
  const a = { titel: 'T', beschreibung: '', chapter_id: 4, zeit: null, figure_ids: ['a', 'b'], motif_ids: [1] };
  assert.equal(beatFieldsEqual(a, { ...a, figure_ids: ['b', 'a'], chapter_id: '4', zeit: undefined }), true);
  assert.equal(beatFieldsEqual(a, { ...a, titel: 'U' }), false);
  assert.equal(beatFieldsEqual(a, { ...a, motif_ids: [1, 2] }), false);
});

const fullBeat = (id, titel) => ({
  id, titel, beschreibung: 'D', status: 'geplant', chapter_id: null, intensitaet: null, zeit: null,
  fig_ids: [], draft_fig_ids: [], motifs: [], locations: [], act_id: 1, thread_id: null, sort_order: 0,
});

test('saveEditBeat: unveränderter Draft → kein PATCH, kein Undo-Record, Panel zu', async () => {
  const b = fullBeat(1, 'Titel');
  const ctx = makeCtx({ beats: [b] });
  await ctx.startEditBeat(b);
  const ok = await ctx.saveEditBeat(b);
  assert.equal(ok, true);
  assert.equal(fetchLog.length, 0);
  assert.equal(ctx._undoStack.length, 0);
  assert.equal(ctx.editingBeatId, null);
});

test('saveEditBeat: echte Änderung → genau ein PATCH + Record, auch bei Doppel-Commit', async () => {
  const b = fullBeat(1, 'Titel');
  const ctx = makeCtx({ beats: [b] });
  await ctx.startEditBeat(b);
  ctx.beatDraft.titel = 'Neu';
  fetchQueue.push({ ok: true, body: { ...b, titel: 'Neu' } });
  const [r1, r2] = await Promise.all([ctx.saveEditBeat(b), ctx.commitEditBeat(b)]);
  assert.equal(r1, true); assert.equal(r2, true);
  assert.equal(fetchLog.filter(f => f.method === 'PATCH').length, 1);
  assert.equal(ctx._undoStack.length, 1);
  assert.equal(ctx.beats[0].titel, 'Neu');
});

test('startEditBeat committet den offenen anderen Beat zuerst und setzt den Beziehungs-Draft zurück', async () => {
  const b1 = fullBeat(1, 'Eins');
  const b2 = fullBeat(2, 'Zwei');
  const ctx = makeCtx({ beats: [b1, b2] });
  await ctx.startEditBeat(b1);
  ctx.beatDraft.titel = 'Eins geändert';
  ctx.relDraftTyp = 'fuehrt-zu'; ctx.relDraftTarget = '2';
  fetchQueue.push({ ok: true, body: { ...b1, titel: 'Eins geändert' } });
  await ctx.startEditBeat(b2);
  assert.equal(fetchLog[0].url, '/plot/beats/1');
  assert.equal(fetchLog[0].body.titel, 'Eins geändert');
  assert.equal(ctx.editingBeatId, 2);
  assert.equal(ctx.beatDraft.titel, 'Zwei');
  assert.equal(ctx.relDraftTyp, '');
  assert.equal(ctx.relDraftTarget, '');
});

test('startEditBeat: scheitert das Speichern des alten Beats, bleibt er offen', async () => {
  const b1 = fullBeat(1, 'Eins');
  const b2 = fullBeat(2, 'Zwei');
  const ctx = makeCtx({ beats: [b1, b2] });
  await ctx.startEditBeat(b1);
  ctx.beatDraft.titel = 'Eins geändert';
  fetchQueue.push({ ok: false, body: {} });
  const ok = await ctx.startEditBeat(b2);
  assert.equal(ok, false);
  assert.equal(ctx.editingBeatId, 1);
  assert.equal(ctx.beatDraft.titel, 'Eins geändert');
});

test('startEditBeat auf denselben Beat lässt den Draft stehen', async () => {
  const b1 = fullBeat(1, 'Eins');
  const ctx = makeCtx({ beats: [b1] });
  await ctx.startEditBeat(b1);
  ctx.beatDraft.titel = 'in Arbeit';
  await ctx.startEditBeat(b1);
  assert.equal(ctx.beatDraft.titel, 'in Arbeit');
  assert.equal(fetchLog.length, 0);
});

test('_pruneBeatsLocal entfernt Beats, ein-/ausgehende Kanten und den offenen Edit', () => {
  const ctx = makeCtx({
    beats: [fullBeat(1, 'A'), fullBeat(2, 'B'), fullBeat(3, 'C')],
    relations: [
      { id: 1, from_beat_id: 1, to_beat_id: 2 },
      { id: 2, from_beat_id: 3, to_beat_id: 1 },
      { id: 3, from_beat_id: 2, to_beat_id: 3 },
    ],
    editingBeatId: 1,
  });
  nav.plotBeatId = 1;
  ctx._pruneBeatsLocal([1]);
  assert.deepEqual(ctx.beats.map(b => b.id), [2, 3]);
  assert.deepEqual(ctx.relations.map(r => r.id), [3]);
  assert.equal(ctx.editingBeatId, null);
  assert.equal(nav.plotBeatId, null);
});

test('Undo setzt busy während des Flights; Mutationen kehren dann früh zurück', async () => {
  const ctx = makeCtx({ beats: [fullBeat(1, 'A')] });
  let busyDuring = null;
  let release;
  ctx._applyInverse = async () => {
    busyDuring = ctx.busy;
    await new Promise(r => { release = r; });
    return true;
  };
  ctx._pushUndo({ kind: 'beat-fields', id: 1, before: {}, after: {} });
  const p = ctx.historyUndo();
  assert.equal(busyDuring, true);
  await ctx.toggleBeatVerworfen(ctx.beats[0]);   // während des Flights
  assert.equal(fetchLog.length, 0, 'kein PATCH während Undo');
  await ctx.historyUndo();                   // Doppelklick
  release();
  await p;
  assert.equal(ctx.busy, false);
  assert.equal(ctx._redoStack.length, 1);
  assert.equal(ctx._undoStack.length, 0);
});

test('leert ein Applier die Historie (loadBoard-Rollback), wird der Record nicht zurückgelegt', async () => {
  const ctx = makeCtx();
  ctx._applyInverse = async () => { ctx._clearHistory(); return false; };
  ctx._pushUndo({ kind: 'beat-place', before: [], after: [] });
  await ctx.historyUndo();
  assert.equal(ctx._undoStack.length, 0);
  assert.equal(ctx._redoStack.length, 0);
});

test('moveAct: unveränderlich umgebaut, bei PUT-Fehler Snapshot zurück und kein Record', async () => {
  const a1 = { id: 1, position: 0, thread_id: null };
  const a2 = { id: 2, position: 1, thread_id: null };
  const ctx = makeCtx({ acts: [a1, a2] });
  fetchQueue.push({ ok: false, body: {} });
  await ctx.moveAct(a1, 1);
  assert.equal(ctx.acts[0], a1, 'Original-Objekte zurück');
  assert.equal(a1.position, 0, 'kein In-place-Mutieren');
  assert.equal(ctx._undoStack.length, 0);

  fetchQueue.push({ ok: true, body: {} });
  await ctx.moveAct(a1, 1);
  assert.deepEqual(ctx.acts.map(a => [a.id, a.position]), [[1, 1], [2, 0]]);
  assert.equal(a1.position, 0);
  assert.deepEqual(ctx._undoStack.at(-1), { kind: 'act-order', before: [1, 2], after: [2, 1] });
});

test('_hApplyActOrder rollt bei Fehler den lokalen Stand zurück', async () => {
  const acts = [{ id: 1, position: 0 }, { id: 2, position: 1 }];
  const ctx = makeCtx({ acts });
  fetchQueue.push({ ok: false, body: {} });
  const ok = await ctx._hApplyActOrder([2, 1]);
  assert.equal(ok, false);
  assert.equal(ctx.acts, acts);
});

test('Spannungsbogen mit Strängen: „ohne Strang"-Beats bilden eine eigene Serie', () => {
  const ctx = makeCtx({
    acts: [{ id: 1, position: 0 }],
    threads: [{ id: 7, position: 0, name: 'A-Story' }],
    beats: [
      { id: 1, act_id: 1, thread_id: 7, sort_order: 0, intensitaet: 2 },
      { id: 2, act_id: 1, thread_id: null, sort_order: 1, intensitaet: 4 },
      { id: 3, act_id: 1, thread_id: 42, sort_order: 2, intensitaet: 5 }, // gelöschter Strang
    ],
  });
  const tc = ctx.tensionCurve();
  assert.deepEqual(tc.series.map(s => [s.key, s.count]), [['t7', 1], ['tnone', 2]]);
  assert.equal(tc.series.reduce((n, s) => n + s.count, 0), tc.count, 'Serien decken count ab');
  assert.equal(tc.series[1].thread, null);
  // Ohne Stränge keine Serien (flaches Board, globale Kurve).
  const flat = makeCtx({ acts: ctx.acts, beats: ctx.beats.map(b => ({ ...b, thread_id: null })) });
  assert.equal(flat.tensionCurve().series.length, 0);
});

test('relTargetTitle liest den Ziel-Titel live aus dem Board, Snapshot nur als Fallback', () => {
  const ctx = makeCtx({ beats: [fullBeat(2, 'Umbenannt')] });
  assert.equal(ctx.relTargetTitle({ to_beat_id: 2, to_titel: 'Alt' }), 'Umbenannt');
  assert.equal(ctx.relTargetTitle({ to_beat_id: 99, to_titel: 'Snapshot' }), 'Snapshot');
  assert.equal(ctx.relTargetTitle(null), '');
});

test('Beat löschen → Undo legt aus dem Snapshot neu an und schreibt die neue ID um; Redo löscht wieder', async () => {
  const b1 = { ...fullBeat(1, 'A'), verworfen: 0, fig_ids: ['f1'], sort_order: 0 };
  const b2 = { ...fullBeat(2, 'B'), sort_order: 1 };
  const ctx = makeCtx({
    beats: [b1, b2],
    relations: [{ id: 5, from_beat_id: 2, to_beat_id: 1, typ: 'setup' }],
    ideasFor: (id) => (id === 1 ? [{ idea_id: 77 }] : []),
    _persistCells: async () => true,
  });
  window.__app.appConfirm = async () => true;
  ctx._pushUndo({ kind: 'beat-fields', id: 1, before: { titel: 'X' }, after: { titel: 'A' } });

  await ctx.deleteBeat(b1);
  assert.equal(ctx.beats.length, 1);
  assert.equal(ctx._undoStack.at(-1).kind, 'delete-beat');
  assert.equal(ctx._undoStack.length, 2, 'Löschen leert die Historie nicht');

  fetchLog = [];
  fetchQueue = [
    { ok: true, body: { ...fullBeat(99, 'A'), fig_ids: ['f1'], sort_order: 2 } },     // POST /plot/beats
    { ok: true, body: { id: 50, from_beat_id: 2, to_beat_id: 99, typ: 'setup' } },  // POST relation
    { ok: true, body: {} },                                                         // POST idea link
  ];
  await ctx.historyUndo();
  const post = fetchLog.find(f => f.url === '/plot/beats');
  assert.equal(post.method, 'POST');
  assert.equal(post.body.titel, 'A');
  assert.deepEqual(post.body.figure_ids, ['f1']);
  assert.equal(post.body.act_id, 1);
  assert.ok(fetchLog.some(f => f.url === '/plot/beat-relations' && f.body.to_beat_id === 99));
  assert.ok(fetchLog.some(f => f.url === '/ideen/77/links' && f.body.target_id === 99));
  assert.deepEqual(ctx.beats.map(b => b.id).sort(), [2, 99]);
  assert.equal(ctx.beats.find(b => b.id === 99).sort_order, 0, 'alte Position wiederhergestellt');
  assert.equal(ctx._undoStack[0].id, 99, 'älterer Record zeigt auf die neue ID');
  assert.equal(ctx._redoStack.at(-1).id, 99);

  fetchLog = [];
  await ctx.historyRedo();
  assert.equal(fetchLog[0].method, 'DELETE');
  assert.equal(fetchLog[0].url, '/plot/beats/99');
  assert.deepEqual(ctx.beats.map(b => b.id), [2]);
  assert.equal(ctx._undoStack.at(-1).kind, 'delete-beat');
  delete window.__app.appConfirm;
});

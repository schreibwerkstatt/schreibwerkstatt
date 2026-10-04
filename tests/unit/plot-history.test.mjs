// Tests für die Undo/Redo-Historie der Plot-Werkstatt (public/js/book/plot/history.js).
//   - Stack-Mechanik: Kapazität, Redo-Invalidierung, Re-Entry-Guard (_inHistoryFlight)
//   - Records tragen Werte, keine Referenzen (die Drop-Mechanik mutiert Beats in place)
//   - Undo/Redo-Zyklus: Record wandert zwischen den Stacks, Fehlschlag legt ihn zurück
//   - create-Undo invalidiert den Redo-Stack (Wiederanlegen vergäbe eine neue ID)
//   - _hApplyPlacements: nur abweichende Beats anfassen, betroffene Zellen
//     (Quelle + Ziel) neu durchnummerieren und genau diese persistieren
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyMethods } from '../../public/js/book/plot/history.js';
import { lifecycleMethods } from '../../public/js/book/plot/lifecycle.js';
import { boardMethods } from '../../public/js/book/plot/derived/board.js';

// Minimal-Kontext statt Alpine-Karte: die Methoden hängen nur an `this`.
function makeCtx(beats = []) {
  const persisted = [];
  return {
    ...lifecycleMethods,
    ...boardMethods,
    ...historyMethods,
    beats,
    acts: [],
    threads: [],
    relations: [],
    busy: false,
    errorMessage: '',
    _memos: {},
    _undoStack: [],
    _redoStack: [],
    _inHistoryFlight: false,
    persisted,
    async _persistCells(cells) { persisted.push(cells); return true; },
  };
}

const beat = (id, actId, threadId, sortOrder) =>
  ({ id, act_id: actId, thread_id: threadId, sort_order: sortOrder, titel: `B${id}` });

test('_pushUndo begrenzt auf 10 Records und wirft die ältesten weg', () => {
  const ctx = makeCtx();
  for (let i = 0; i < 14; i++) ctx._pushUndo({ kind: 'beat-fields', id: i, before: {}, after: {} });
  assert.equal(ctx._undoStack.length, 10);
  assert.equal(ctx._undoStack[0].id, 4);
  assert.equal(ctx._undoStack.at(-1).id, 13);
});

test('neuer Record leert den Redo-Stack, Redo-Rückweg nicht', () => {
  const ctx = makeCtx();
  ctx._redoStack = [{ kind: 'beat-fields', id: 1, before: {}, after: {} }];
  ctx._pushUndo({ kind: 'beat-fields', id: 2, before: {}, after: {} });
  assert.equal(ctx._redoStack.length, 0);

  ctx._redoStack = [{ kind: 'beat-fields', id: 3, before: {}, after: {} }];
  ctx._pushUndo({ kind: 'beat-fields', id: 4, before: {}, after: {} }, { clearRedo: false });
  assert.equal(ctx._redoStack.length, 1);
});

test('während Undo/Redo wird nichts aufgezeichnet (kein rekursiver Stack)', () => {
  const ctx = makeCtx();
  ctx._inHistoryFlight = true;
  ctx._pushUndo({ kind: 'beat-fields', id: 1, before: {}, after: {} });
  assert.equal(ctx._undoStack.length, 0);
});

test('_snapshotPlacements kopiert Werte, nicht Referenzen', () => {
  const b = beat(1, 10, null, 0);
  const ctx = makeCtx([b]);
  const snap = ctx._snapshotPlacements();
  b.act_id = 99;
  b.sort_order = 5;
  assert.deepEqual(snap, [{ id: 1, act_id: 10, thread_id: null, sort_order: 0 }]);
});

test('Undo/Redo-Zyklus schiebt den Record zwischen den Stacks', async () => {
  const ctx = makeCtx();
  const applied = [];
  ctx._applyInverse = async (rec) => { applied.push(['inverse', rec.id]); return true; };
  ctx._applyForward = async (rec) => { applied.push(['forward', rec.id]); return true; };
  ctx._pushUndo({ kind: 'beat-fields', id: 7, before: { titel: 'alt' }, after: { titel: 'neu' } });

  await ctx.plotHistoryUndo();
  assert.equal(ctx._undoStack.length, 0);
  assert.equal(ctx._redoStack.length, 1);

  await ctx.plotHistoryRedo();
  assert.equal(ctx._undoStack.length, 1);
  assert.equal(ctx._redoStack.length, 0);
  assert.deepEqual(applied, [['inverse', 7], ['forward', 7]]);
});

test('fehlgeschlagenes Undo legt den Record zurück', async () => {
  const ctx = makeCtx();
  ctx._applyInverse = async () => false;
  ctx._pushUndo({ kind: 'beat-fields', id: 7, before: {}, after: {} });
  await ctx.plotHistoryUndo();
  assert.equal(ctx._undoStack.length, 1);
  assert.equal(ctx._redoStack.length, 0);
});

test('Undo eines create invalidiert den gesamten Redo-Stack', async () => {
  const ctx = makeCtx();
  ctx._applyInverse = async () => true;
  ctx._pushUndo({ kind: 'beat-place', before: [], after: [] });
  ctx._pushUndo({ kind: 'create-beat', id: 5 }, { clearRedo: false });
  await ctx.plotHistoryUndo();           // create-beat → löschen
  assert.equal(ctx._redoStack.length, 0, 'kein Redo nach create-Undo (neue ID beim Wiederanlegen)');
  assert.equal(ctx._undoStack.length, 1, 'ältere Records bleiben undo-bar');
});

test('laufende Mutation (busy) blockiert Undo', async () => {
  const ctx = makeCtx();
  ctx.busy = true;
  ctx._applyInverse = async () => true;
  ctx._pushUndo({ kind: 'beat-fields', id: 1, before: {}, after: {} });
  await ctx.plotHistoryUndo();
  assert.equal(ctx._undoStack.length, 1);
});

test('_hApplyPlacements stellt die Reihenfolge her und persistiert nur die Zelle', async () => {
  // Ausgangsstand: B1,B2,B3 in Zelle (Akt 10, ohne Strang)
  const beats = [beat(1, 10, null, 0), beat(2, 10, null, 1), beat(3, 10, null, 2)];
  const ctx = makeCtx(beats);
  const before = ctx._snapshotPlacements();
  // Drop: B3 nach vorne
  beats[2].sort_order = 0; beats[0].sort_order = 1; beats[1].sort_order = 2;
  ctx._memos = {};

  const ok = await ctx._hApplyPlacements(before);
  assert.equal(ok, true);
  assert.deepEqual(ctx.beatsForCell(10, null).map(b => b.id), [1, 2, 3]);
  assert.deepEqual(ctx.beatsForCell(10, null).map(b => b.sort_order), [0, 1, 2]);
  assert.deepEqual(ctx.persisted, [[{ actId: 10, threadId: null }]]);
});

test('_hApplyPlacements persistiert bei Zell-Wechsel Quelle UND Ziel', async () => {
  const beats = [beat(1, 10, null, 0), beat(2, 10, null, 1), beat(3, 20, 7, 0)];
  const ctx = makeCtx(beats);
  const before = ctx._snapshotPlacements();
  // Drop: B2 aus (10, null) in die Zelle (20, 7) vor B3
  beats[1].act_id = 20; beats[1].thread_id = 7; beats[1].sort_order = 0;
  beats[2].sort_order = 1;
  ctx._memos = {};

  await ctx._hApplyPlacements(before);
  assert.deepEqual(ctx.beatsForCell(10, null).map(b => b.id), [1, 2]);
  assert.deepEqual(ctx.beatsForCell(20, 7).map(b => b.id), [3]);
  const cells = ctx.persisted[0].map(c => `${c.actId}:${c.threadId}`).sort();
  assert.deepEqual(cells, ['10:null', '20:7']);
});

test('_hApplyPlacements ist ein No-op ohne Abweichung (kein PUT)', async () => {
  const beats = [beat(1, 10, null, 0), beat(2, 10, null, 1)];
  const ctx = makeCtx(beats);
  const ok = await ctx._hApplyPlacements(ctx._snapshotPlacements());
  assert.equal(ok, true);
  assert.equal(ctx.persisted.length, 0);
});

test('_hApplyPlacements lässt seit dem Snapshot neue Beats stehen', async () => {
  const beats = [beat(1, 10, null, 0), beat(2, 10, null, 1)];
  const ctx = makeCtx(beats);
  const before = ctx._snapshotPlacements();
  // Danach angelegt (nicht im Snapshot) + Reihenfolge der bekannten getauscht
  beats.push(beat(9, 10, null, 2));
  beats[0].sort_order = 1; beats[1].sort_order = 0;
  ctx._memos = {};

  await ctx._hApplyPlacements(before);
  assert.deepEqual(ctx.beatsForCell(10, null).map(b => b.id), [1, 2, 9], 'neuer Beat reiht sich hinten ein');
  assert.deepEqual(ctx.beatsForCell(10, null).map(b => b.sort_order), [0, 1, 2]);
});

test('_beatFieldSnapshot bildet die PATCH-Form des Beat-Stands', () => {
  const ctx = makeCtx();
  const snap = ctx._beatFieldSnapshot({
    id: 1, titel: 'T', beschreibung: null, status: 'im_buch', chapter_id: 4,
    intensitaet: 3, zeit: 'Sommer 1987', fig_ids: ['f1'], draft_fig_ids: [2],
    motifs: [{ id: 5 }, { id: 6 }], locations: [{ id: 'l1' }],
  });
  assert.deepEqual(snap, {
    titel: 'T', beschreibung: '', status: 'im_buch', chapter_id: 4, intensitaet: 3,
    zeit: 'Sommer 1987',
    figure_ids: ['f1'], draft_figure_ids: [2], motif_ids: [5, 6], location_ids: ['l1'],
  });
});

// Das Snapshot-Objekt IST das Undo-Ziel: fehlt darin ein Feld, das der PATCH
// schreibt, kann Undo es nicht zuruecknehmen. Darum die Gegenprobe mit leerem
// Beat — jedes Feld muss auch dann im Snapshot stehen.
test('_beatFieldSnapshot laesst kein PATCH-Feld aus (auch bei leerem Beat)', () => {
  const ctx = makeCtx();
  const snap = ctx._beatFieldSnapshot({ id: 1, titel: 'T' });
  assert.deepEqual(Object.keys(snap).sort(), [
    'beschreibung', 'chapter_id', 'draft_figure_ids', 'figure_ids',
    'intensitaet', 'location_ids', 'motif_ids', 'status', 'titel', 'zeit',
  ]);
  assert.deepEqual(snap.location_ids, []);
  assert.equal(snap.zeit, null);
});

// Doku-Invariante (docs/plot.md, Undo/Redo): jede Board-Mutation zeichnet auf
// (_record*), leert die Historie (_clearHistory) oder lädt neu (loadBoard leert
// selbst). Quelltext-Tripwire über die Methods-Module: jede Methode, die eine
// schreibende /plot-Route anspricht, muss einen der drei Wege gehen. Ausgenommen
// sind die _h*-Applier (die sind der Undo-Weg selbst), _persistCells (Helfer,
// dessen Aufrufer aufzeichnen) und die KI-Lauf-Historie (keine Board-Daten).
import { readFileSync } from 'node:fs';
test('jede schreibende Plot-Methode zeichnet auf oder leert die Historie', () => {
  // Dazu die Module, die über andere Wege aufs Board schreiben: Befund-Aktionen,
  // Verschieben ohne Drag, Drag & Drop, Plot-Chat-Übernahme.
  const files = [
    ...['acts', 'beats', 'threads', 'ai', 'history', 'konflikt-actions', 'beat-move', 'dnd']
      .map(f => `public/js/book/plot/${f}.js`),
    'public/js/chat/plot-chat-proposals.js',
  ];
  // _placePlotAct: Platzierung eines gerade angelegten Akts, dessen create-act-
  // Record das Undo samt Platz trägt. _patchPlotProposal: Vorschlags-Status,
  // keine Board-Daten.
  const exempt = new Set(['_persistCells', 'deleteConsistencyRun', 'deleteBrainstormRun',
    '_placePlotAct', '_patchPlotProposal']);
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    const parts = src.split(/\n {2}(?=(?:async )?[A-Za-z_$][\w$]*\([^)]*\)\s*\{)/);
    for (const part of parts) {
      const m = part.match(/^(?:async )?([A-Za-z_$][\w$]*)\(/);
      if (!m) continue;
      const name = m[1];
      if (name.startsWith('_h') || exempt.has(name)) continue;
      const writes = /fetchJson\(`?'?\/plot\/[^,]*,\s*\{[^}]*method:\s*'(PATCH|POST|PUT|DELETE)'/s.test(part)
        || /method:\s*'(PATCH|POST|PUT|DELETE)'/.test(part) && /\/plot\//.test(part);
      if (!writes) continue;
      if (!/_record\w*\(|_clearHistory\(|loadBoard\(/.test(part)) offenders.push(`${f}#${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

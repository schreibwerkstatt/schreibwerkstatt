// Plan-Reiter im Referenz-Panel: Board-Reihenfolge + Kontext-Regel.
// Ein Beat haengt am KAPITEL; „in diesem Abschnitt" (refCtx 'page') kommt allein aus
// der Beat-Verankerung (occ_top[].page_id), nie aus dem Plan selbst.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPlanBeats, selectPlanBeatsForPage, planCastLookup, planCastRefs, planMotifRefs } from '../../public/js/cards/reference-plan.js';

const plan = {
  acts: [{ id: 10, position: 1 }, { id: 11, position: 0 }],
  beats: [
    { id: 1, act_id: 10, sort_order: 0, chapter_id: 5, status: 'geplant', occ_top: [] },
    { id: 2, act_id: 11, sort_order: 1, chapter_id: 5, status: 'im_buch', occ_top: [{ page_id: 77 }] },
    { id: 3, act_id: 11, sort_order: 0, chapter_id: 6, status: 'geplant' },
    { id: 4, act_id: 11, sort_order: 2, chapter_id: 5, status: 'geplant', verworfen: 1 },
    { id: 5, act_id: 10, sort_order: 1, chapter_id: null, status: 'geplant' },
  ],
};

test('orderPlanBeats: Akt-Position vor sort_order, verworfene fallen raus', () => {
  assert.deepEqual(orderPlanBeats(plan).map(b => b.id), [3, 2, 1, 5]);
});

test('orderPlanBeats: leerer/fehlender Plan ergibt leere Liste', () => {
  assert.deepEqual(orderPlanBeats(null), []);
  assert.deepEqual(orderPlanBeats({ acts: [], beats: [] }), []);
});

test('selectPlanBeatsForPage: nur Beats des Kapitels, auf der Seite verankerte zuerst', () => {
  const out = selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: 77, chapterId: 5 });
  assert.deepEqual(out.map(b => [b.id, b.refCtx]), [[2, 'page'], [1, 'chapter']]);
});

test('selectPlanBeatsForPage: IDs als String und Zahl vergleichbar', () => {
  const out = selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: '77', chapterId: '5' });
  assert.deepEqual(out.map(b => b.id), [2, 1]);
});

test('selectPlanBeatsForPage: Seite ohne Kapitel zeigt keinen Plan', () => {
  assert.deepEqual(selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: 1, chapterId: null }), []);
});

test('selectPlanBeatsForPage: Beat ohne eigenes Kapitel erbt das seines Strangs', () => {
  const ordered = orderPlanBeats({
    acts: [{ id: 1, position: 0 }],
    beats: [
      { id: 8, act_id: 1, sort_order: 0, chapter_id: null, thread_id: 3 },
      { id: 9, act_id: 1, sort_order: 1, chapter_id: 6, thread_id: 3 },   // eigenes Kapitel schlaegt Strang
    ],
  });
  const out = selectPlanBeatsForPage(ordered, { pageId: 1, chapterId: 5, threads: [{ id: 3, chapter_id: 5 }] });
  assert.deepEqual(out.map(b => b.id), [8]);
});

// Verbindliche Lesereihenfolge: Lane für Lane (Stränge nach position, „ohne
// Strang" zuletzt), je Lane die eigenen Akte des Strangs — sonst die geteilten —
// nach position, dann sort_order. Geteilte und strang-eigene Akt-Positionen sind
// zwei unabhängige 0..n-Sequenzen und dürfen nicht global gemischt werden.
test('orderPlanBeats: Lesereihenfolge pro Lane, eigene Akte vor geteilten', () => {
  const ordered = orderPlanBeats({
    acts: [
      { id: 1, position: 0, thread_id: null },   // geteilt A
      { id: 2, position: 1, thread_id: null },   // geteilt B
      { id: 9, position: 0, thread_id: 7 },      // eigener Akt von Strang 7
    ],
    threads: [{ id: 7, position: 1 }, { id: 5, position: 0 }],
    beats: [
      { id: 10, act_id: 2, thread_id: null, sort_order: 0 },
      { id: 11, act_id: 1, thread_id: null, sort_order: 0 },
      { id: 12, act_id: 9, thread_id: 7, sort_order: 0 },
      { id: 13, act_id: 2, thread_id: 5, sort_order: 0 },
      { id: 14, act_id: 1, thread_id: 5, sort_order: 1 },
      { id: 15, act_id: 1, thread_id: 5, sort_order: 0 },
      { id: 16, act_id: 1, thread_id: 99, sort_order: 2 }, // unbekannter Strang → ohne Strang
    ],
  });
  assert.deepEqual(ordered.map(b => b.id), [15, 14, 13, 12, 11, 16, 10]);
});

test('planCastRefs: Katalog + Werkstatt + geerbte Strang-Figur + Orte als Referenzen, dedupliziert', () => {
  const lookup = planCastLookup({
    figuren: [{ id: 'f1', name: 'Anna Berg', kurzname: 'Anna' }, { id: 'f2', name: 'Ben' }],
    draftFigures: [{ id: 4, name: 'Cleo (Werkstatt)' }],
    threads: [{ id: 3, fig_id: 'f2' }, { id: 6, draft_figure_id: 4 }, { id: 7, fig_id: 'f1' }],
  });
  assert.deepEqual(
    planCastRefs({ fig_ids: ['f1'], draft_fig_ids: [4], thread_id: 3, locations: [{ id: 9, name: 'Hafen' }] }, lookup),
    [
      { type: 'figur', id: 'f1' },
      { type: 'werkstatt', id: 4, label: 'Cleo (Werkstatt)' },
      { type: 'figur', id: 'f2', inherited: true },
      { type: 'ort', id: 9, label: 'Hafen' },
    ]);
  // Strang-Figur schon explizit am Beat → keine Doppelnennung (Werkstatt wie Katalog)
  assert.deepEqual(planCastRefs({ draft_fig_ids: [4], thread_id: 6 }, lookup),
    [{ type: 'werkstatt', id: 4, label: 'Cleo (Werkstatt)' }]);
  assert.deepEqual(planCastRefs({ fig_ids: ['f1'], thread_id: 7 }, lookup), [{ type: 'figur', id: 'f1' }]);
  // Figur, die der Katalog nicht kennt, fällt weg statt als «#fig_x» zu stehen
  assert.deepEqual(planCastRefs({ fig_ids: ['fig_unbekannt'] }, lookup), []);
  assert.deepEqual(planCastRefs(null, lookup), []);
});

test('planMotifRefs: Motive mit ID als Motiv-Referenzen, Label vom Beat', () => {
  assert.deepEqual(planMotifRefs({ motifs: [{ id: 2, name: 'Wasser' }, { name: 'ohne ID' }] }),
    [{ type: 'motiv', id: 2, label: 'Wasser' }]);
  assert.deepEqual(planMotifRefs(null), []);
});

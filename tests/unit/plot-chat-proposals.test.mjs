// Plot-Chat-Vorschläge im Frontend (public/js/chat/plot-chat-proposals.js):
// pure Zustandslogik gegen das Board — übernommen/verworfen/offen, „Angelegtes
// wieder weg" (Undo), Blockaden (Ziel weg, Bezugs-Akt noch nicht übernommen),
// Stale-Hinweis — und die Diff-Zeilen eines Beat-Änderungs-Vorschlags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalStatus, refAppliedId, beatUpdateRows, relationBeatId } from '../../public/js/chat/plot-chat-proposals.js';

const board = {
  acts: [{ id: 1, thread_id: null }, { id: 2, thread_id: null }],
  threads: [{ id: 7 }],
  beats: [{ id: 10, act_id: 1, thread_id: null, titel: 'Alt', beschreibung: '', fig_ids: ['a'], draft_fig_ids: [], verworfen: 0 }],
};

test('neuer Beat: offen → übernommen; Angelegtes weg → wieder offen (removed)', () => {
  const p = { type: 'beat_create', act_id: 1, thread_id: null, fields: { titel: 'Neu' } };
  assert.equal(proposalStatus(p, [p], board).state, 'open');
  const applied = { ...p, applied_at: 'x', applied_id: 10 };
  assert.equal(proposalStatus(applied, [applied], board).state, 'applied');
  const gone = { ...p, applied_at: 'x', applied_id: 999 };
  const st = proposalStatus(gone, [gone], board);
  assert.equal(st.state, 'open');
  assert.equal(st.removed, true);
});

test('verworfen bleibt verworfen; Änderung an gelöschtem Beat ist blockiert', () => {
  assert.equal(proposalStatus({ type: 'act_update', act_id: 1, status: 'discarded' }, [], board).state, 'discarded');
  const st = proposalStatus({ type: 'beat_update', beat_id: 404, fields: { titel: 'x' }, before: { titel: 'y' } }, [], board);
  assert.deepEqual(st.blocked, { key: 'plot.chat.block.beatGone' });
});

test('act_ref: blockiert, bis der Akt-Vorschlag übernommen ist und der Akt existiert', () => {
  const actP = { type: 'act_create', name: 'Auflösung' };
  const beatP = { type: 'beat_create', act_ref: 1, thread_id: null, fields: { titel: 'Showdown' } };
  let st = proposalStatus(beatP, [actP, beatP], board);
  assert.equal(st.blocked.key, 'plot.chat.block.refAct');
  assert.equal(st.blocked.params.name, 'Auflösung');
  const appliedAct = { ...actP, applied_at: 'x', applied_id: 2 };
  st = proposalStatus(beatP, [appliedAct, beatP], board);
  assert.equal(st.blocked, null);
  assert.equal(refAppliedId([appliedAct], 1, 'act', board), 2);
  // Akt wieder entfernt (Undo) → erneut blockiert.
  assert.equal(refAppliedId([{ ...appliedAct, applied_id: 99 }], 1, 'act', board), null);
  // Falsche Art: act_ref auf einen Strang-Vorschlag liefert nichts.
  assert.equal(refAppliedId([{ type: 'thread_create', applied_at: 'x', applied_id: 7 }], 1, 'act', board), null);
});

test('stale: Beat seit dem Vorschlag geändert (Feld oder Figuren)', () => {
  const p = { type: 'beat_update', beat_id: 10, fields: { titel: 'Neu' }, before: { titel: 'Alt' } };
  assert.equal(proposalStatus(p, [p], board).stale, false);
  const changed = { ...board, beats: [{ ...board.beats[0], titel: 'Anders' }] };
  assert.equal(proposalStatus(p, [p], changed).stale, true);
  const fp = { type: 'beat_update', beat_id: 10, fields: { figure_ids: [] }, before: { figure_ids: ['a'] } };
  assert.equal(proposalStatus(fp, [fp], board).stale, false);
  const otherFigs = { ...board, beats: [{ ...board.beats[0], fig_ids: ['b'] }] };
  assert.equal(proposalStatus(fp, [fp], otherFigs).stale, true);
});

test('Verschiebung: Ziel-Akt gelöscht → blockiert; Beat inzwischen woanders → stale', () => {
  const p = { type: 'beat_move', beat_id: 10, act_id: 3, thread_id: null, before: { act_id: 1, thread_id: null } };
  assert.equal(proposalStatus(p, [p], board).blocked.key, 'plot.chat.block.actGone');
  const ok = { ...p, act_id: 2 };
  assert.equal(proposalStatus(ok, [ok], board).stale, false);
  const moved = { ...board, beats: [{ ...board.beats[0], act_id: 2 }] };
  assert.equal(proposalStatus(ok, [ok], moved).stale, true);
});

test('beatUpdateRows: Wort-Diff für Text, Vorher/Nachher für Felder, Flag für verworfen', () => {
  const rows = beatUpdateRows({
    type: 'beat_update',
    fields: { titel: 'Der neue Brief', chapter_id: 5, figure_ids: ['a'], draft_figure_ids: [], verworfen: 1 },
    before: { titel: 'Der Brief', chapter_id: null, figure_ids: [], draft_figure_ids: [], verworfen: 0 },
    labels: { chapter: 'Kap. 2', figuren: ['Anna'], figuren_before: [] },
  });
  assert.deepEqual(rows.map(r => r.key), ['titel', 'chapter', 'figuren', 'verworfen']);
  assert.ok(rows[0].diff.some(part => part.t === 'add' && part.v.includes('neue')));
  assert.deepEqual([rows[1].before, rows[1].after], ['—', 'Kap. 2']);
  assert.deepEqual([rows[2].before, rows[2].after], ['—', 'Anna']);
  assert.equal(rows[3].flag, 'on');
  assert.deepEqual(beatUpdateRows({ type: 'beat_create' }), []);
});

test('Beziehung: offen; übernommen solange die Kante besteht; Beat weg → blockiert', () => {
  const b = { ...board, beats: [...board.beats, { id: 11, act_id: 1, thread_id: null }], relations: [{ id: 50, from_beat_id: 10, to_beat_id: 11, typ: 'fuehrt-zu' }] };
  const p = { type: 'relation_create', from_beat_id: 10, to_beat_id: 11, typ: 'fuehrt-zu' };
  assert.equal(proposalStatus(p, [p], b).state, 'open');
  assert.equal(proposalStatus({ ...p, applied_at: 'x', applied_id: 50 }, [], b).state, 'applied');
  const undone = proposalStatus({ ...p, applied_at: 'x', applied_id: 51 }, [], b);
  assert.equal(undone.state, 'open');
  assert.equal(undone.removed, true);
  assert.deepEqual(proposalStatus({ ...p, to_beat_id: 404 }, [], b).blocked, { key: 'plot.chat.block.beatGone' });
});

test('Beziehung zu neuem Beat: blockiert, bis der Beat übernommen ist', () => {
  const beatP = { type: 'beat_create', act_id: 1, thread_id: null, fields: { titel: 'Payoff' } };
  const relP = { type: 'relation_create', from_beat_id: 10, to_beat_ref: 1, typ: 'bereitet-vor' };
  let st = proposalStatus(relP, [beatP, relP], board);
  assert.equal(st.blocked.key, 'plot.chat.block.refBeat');
  assert.equal(st.blocked.params.name, 'Payoff');
  const applied = { ...beatP, applied_at: 'x', applied_id: 10 };
  st = proposalStatus(relP, [applied, relP], board);
  assert.equal(st.blocked, null);
  assert.equal(relationBeatId(relP, 'to', [applied, relP], board), 10);
});

test('beatUpdateRows: Status als Schlüssel, Orte und Motive mit Vorher-Namen', () => {
  const rows = beatUpdateRows({
    type: 'beat_update', beat_id: 10,
    fields: { status: 'im_buch', location_ids: ['loc_a'], motif_ids: [] },
    before: { status: 'geplant', location_ids: [], motif_ids: [3] },
    labels: { orte: ['Hafen'], orte_before: [], motive: [], motive_before: ['Spiegel'] },
  });
  assert.deepEqual(rows.map(r => [r.key, r.before, r.after]), [
    ['status', 'geplant', 'im_buch'], ['orte', '—', 'Hafen'], ['motive', 'Spiegel', '—'],
  ]);
  assert.equal(rows[0].i18n, 'plot.status.');
});

test('stale: Orte des Beats seit dem Vorschlag geändert', () => {
  const b = { ...board, beats: [{ ...board.beats[0], locations: [{ id: 'loc_b', name: 'Turm' }] }] };
  const p = { type: 'beat_update', beat_id: 10, fields: { location_ids: ['loc_a'] }, before: { location_ids: [] } };
  assert.equal(proposalStatus(p, [p], b).stale, true);
  assert.equal(proposalStatus(p, [p], board).stale, false);
});

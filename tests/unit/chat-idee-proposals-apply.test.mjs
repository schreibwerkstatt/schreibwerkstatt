// Übernehmen von Chat-Vorschlägen im Frontend, geteilt von Plot-Chat, Ideen-Chat
// und den Ideen-Vorschlägen aus Abschnitts- und Buch-Chat
// (public/js/chat/proposal-status.js):
//  - applyProposalOnce: scheitert nur der Status-PATCH, schreibt ein zweiter Klick
//    das Board NICHT erneut (kein Duplikat), sondern holt nur den Status nach;
//  - 409 PROPOSAL_ALREADY_APPLIED ist der Stand, kein Fehler: der gespeicherte
//    Vorschlag wird übernommen.
// Dazu die Prompt-Form beider Vorschlags-Chats (Vorspann-Block, Reihenfolge-Regel,
// Kürzungs-Hinweis nur mit angebotenem Werkzeug) und die Anker-lösen-Anzeige.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposalOnce, persistProposalStatus } from '../../public/js/chat/proposal-status.js';
import { ideenProposalStatus, ideeUpdateRows } from '../../public/js/chat/ideen-chat-proposals.js';
import { beatUpdateRows } from '../../public/js/chat/plot-chat-proposals.js';
import { buildPlotChatSystemPrompt, buildIdeenChatSystemPrompt } from '../../public/js/prompts.js';

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    const { status = 200, body = {} } = await handler(url, opts, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

const mkMsg = () => ({ id: 5, context_info: { proposals: [{ type: 'beat_create', fields: { titel: 'A' } }] } });

test('applyProposalOnce: Status-Fehler → zweiter Klick schreibt nicht doppelt', async () => {
  const msg = mkMsg();
  let writes = 0;
  const write = async () => { writes++; return 42; };
  const calls = mockFetch((url, opts, n) => (n === 1
    ? { status: 500, body: { error_code: 'INTERNAL' } }
    : { body: { proposal: { type: 'beat_create', applied_at: 'T', applied_id: 42 } } }));
  const first = await applyProposalOnce('/plot/chat-proposal', msg, 0, write);
  assert.deepEqual([first.ok, first.phase], [false, 'persist']);
  assert.equal(writes, 1);
  assert.equal(msg.context_info.proposals[0]._written, true);
  const second = await applyProposalOnce('/plot/chat-proposal', msg, 0, write);
  assert.equal(second.ok, true);
  assert.equal(writes, 1, 'Board nur einmal geschrieben');
  assert.equal(calls[1].body.applied_id, 42, 'Status mit der id des ersten Schreibens');
  const p = msg.context_info.proposals[0];
  assert.equal(p.applied_at, 'T');
  assert.equal(p._written, undefined);
});

test('applyProposalOnce: Schreibfehler → phase write, nichts gemerkt', async () => {
  const msg = mkMsg();
  mockFetch(() => ({ body: {} }));
  const r = await applyProposalOnce('/plot/chat-proposal', msg, 0, async () => { throw new Error('boom'); });
  assert.deepEqual([r.ok, r.phase], [false, 'write']);
  assert.equal(msg.context_info.proposals[0]._written, undefined);
});

test('409 PROPOSAL_ALREADY_APPLIED: gespeicherter Stand wird übernommen (applied und discarded)', async () => {
  const stored = { type: 'idee_create', applied_at: 'T0', applied_id: 7 };
  mockFetch(() => ({ status: 409, body: { error_code: 'PROPOSAL_ALREADY_APPLIED', proposal: stored } }));
  const msg = mkMsg();
  const r = await applyProposalOnce('/ideen/chat-proposal', msg, 0, async () => 99);
  assert.equal(r.ok, true);
  assert.equal(msg.context_info.proposals[0].applied_id, 7);
  const msg2 = { id: 6, context_info: { proposals: [{ type: 'idee_create', status: 'discarded' }] } };
  const res = await persistProposalStatus('/ideen/chat-proposal', msg2, 0, 'discarded');
  assert.equal(res.already, true);
  assert.equal(msg2.context_info.proposals[0].applied_at, 'T0');
  assert.equal(msg2.context_info.proposals[0].status, undefined);
  // Andere Fehler bleiben Fehler.
  mockFetch(() => ({ status: 409, body: { error_code: 'SOMETHING_ELSE' } }));
  await assert.rejects(() => persistProposalStatus('/ideen/chat-proposal', mkMsg(), 0, 'applied', 1));
});

test('Anker lösen: Zeile «Ort → ohne Ort», nur für offene Ideen übernehmbar', () => {
  const p = {
    type: 'idee_update', idee_id: 1, fields: { page_id: null, chapter_id: null },
    before: { page_id: 5, chapter_id: null }, labels: { anchor: null, anchor_kind: 'book', anchor_before: 'Der Brief' },
  };
  const rows = ideeUpdateRows(p);
  assert.deepEqual(rows.map(r => [r.key, r.before, r.after]), [['anchor', 'Der Brief', '']]);
  const open = [{ id: 1, content: 'x', status: 'offen', page_id: 5, chapter_id: null, links: [] }];
  assert.equal(ideenProposalStatus(p, [p], open).blocked, null);
  const closed = [{ ...open[0], status: 'erledigt' }];
  assert.equal(ideenProposalStatus(p, [p], closed).blocked.key, 'ideenBoard.chat.block.closed');
});

test('beatUpdateRows: geleerte Felder als «—»', () => {
  const rows = beatUpdateRows({
    type: 'beat_update', fields: { chapter_id: null, zeit: null, intensitaet: null },
    before: { chapter_id: 3, zeit: 'Sommer', intensitaet: 4 }, labels: { chapter_before: 'Kap. 3' },
  });
  assert.deepEqual(rows.map(r => [r.key, r.before, r.after]), [
    ['intensitaet', 4, '—'], ['zeit', 'Sommer', '—'], ['chapter', 'Kap. 3', '—'],
  ]);
});

test('Prompt: Vorspann-Block statt volatiler System-Block; Reihenfolge-Regel; Kürzungs-Hinweis nur mit Werkzeug', () => {
  const ctx = {
    mode: 'agent', boardOutline: 'AKT [#1] «A»', boardTrimmed: true, passages: null,
    boardActs: [{ thread_id: null }, { thread_id: 7 }], toolNames: ['get_plot_board'],
  };
  const blocks = buildPlotChatSystemPrompt('Buch', ctx);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ttl, '1h');
  assert.equal(blocks[1].preamble, true);
  assert.doesNotMatch(blocks[0].text, /AKTUELLES BEAT-BOARD/);
  assert.match(blocks[1].text, /REIHENFOLGE: .*NUR INNERHALB eines Blocks/);
  assert.match(blocks[1].text, /gekürzt.*`get_plot_board`/);
  const without = buildPlotChatSystemPrompt('Buch', { ...ctx, toolNames: [] });
  assert.doesNotMatch(without[1].text, /get_plot_board/);
  const flat = buildPlotChatSystemPrompt('Buch', { ...ctx, boardActs: [{ thread_id: null }] });
  assert.match(flat[1].text, /REIHENFOLGE: Die Board-Reihenfolge ergibt sich aus Akt → Beat/);
  const classic = buildPlotChatSystemPrompt('Buch', { ...ctx, mode: 'classic', passages: [] });
  assert.doesNotMatch(classic[1].text, /get_plot_board/, 'klassisch nennt kein Werkzeug');

  const ideen = buildIdeenChatSystemPrompt('Buch', { mode: 'agent', ideenOutline: 'x', ideenTrimmed: true, toolNames: [] });
  assert.equal(ideen[1].preamble, true);
  assert.match(ideen[1].text, /Ideenliste ist für den Prompt gekürzt/);
  assert.doesNotMatch(ideen[1].text, /list_ideen/);
});

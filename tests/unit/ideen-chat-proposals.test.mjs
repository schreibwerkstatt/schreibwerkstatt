// Ideen-Chat-Vorschläge im Frontend (public/js/chat/ideen-chat-proposals.js):
// pure Zustandslogik gegen den Board-Bestand — übernommen/verworfen/offen,
// „Angelegtes wieder weg", Blockaden (Idee weg, Bezugs-Idee noch nicht
// übernommen, Stufe abgeschaltet, abgeschlossen, schon verknüpft), Stale-Hinweis
// — und die Diff-Zeilen einer Änderung. Dazu der gebaute Prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ideenProposalStatus, refAppliedIdeeId, ideeUpdateRows } from '../../public/js/chat/ideen-chat-proposals.js';
import {
  buildIdeenChatSystemPrompt, IDEEN_CHAT_PROPOSE_TOOLS, SCHEMA_IDEEN_CHAT_CLASSIC,
  chatToolNames, CHAT_TOOLS,
} from '../../public/js/prompts.js';

const ideen = [
  { id: 1, content: 'Alt', status: 'offen', page_id: null, chapter_id: null, links: [] },
  { id: 2, content: 'Fertig', status: 'erledigt', page_id: 5, chapter_id: null, links: [{ target_kind: 'beat', target_id: 9 }] },
];
const STAGES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

test('neue Idee: offen → übernommen; Angelegtes weg → wieder offen (removed)', () => {
  const p = { type: 'idee_create', fields: { content: 'Neu' } };
  assert.equal(ideenProposalStatus(p, [p], ideen, STAGES).state, 'open');
  assert.equal(ideenProposalStatus({ ...p, applied_at: 'x', applied_id: 1 }, [], ideen, STAGES).state, 'applied');
  const st = ideenProposalStatus({ ...p, applied_at: 'x', applied_id: 404 }, [], ideen, STAGES);
  assert.equal(st.state, 'open');
  assert.equal(st.removed, true);
});

test('Änderung: Idee weg, Stufe abgeschaltet, abgeschlossen beim Umzug → blockiert', () => {
  const gone = ideenProposalStatus({ type: 'idee_update', idee_id: 404, fields: { status: 'erledigt' }, before: {} }, [], ideen, STAGES);
  assert.equal(gone.blocked.key, 'ideenBoard.chat.block.ideeGone');
  const inactive = ideenProposalStatus({ type: 'idee_update', idee_id: 1, fields: { status: 'verworfen' }, before: { status: 'offen' } }, [], ideen, ['offen', 'erledigt']);
  assert.equal(inactive.blocked.key, 'ideenBoard.chat.block.stageInactive');
  const closed = ideenProposalStatus({ type: 'idee_update', idee_id: 2, fields: { page_id: 6 }, before: { page_id: 5, chapter_id: null } }, [], ideen, STAGES);
  assert.equal(closed.blocked.key, 'ideenBoard.chat.block.closed');
});

test('Stale: Idee seit dem Vorschlag geändert → Hinweis, kein Block', () => {
  const st = ideenProposalStatus({ type: 'idee_update', idee_id: 1, fields: { content: 'X' }, before: { content: 'Anders' } }, [], ideen, STAGES);
  assert.equal(st.blocked, null);
  assert.equal(st.stale, true);
  assert.equal(ideenProposalStatus({ type: 'idee_update', idee_id: 1, fields: { content: 'X' }, before: { content: 'Alt' } }, [], ideen, STAGES).stale, false);
});

test('Verknüpfung: idee_ref erst nach Übernahme, bestehende Kante blockiert', () => {
  const create = { type: 'idee_create', fields: { content: 'Neu' } };
  const link = { type: 'link_create', idee_ref: 1, target_kind: 'beat', target_id: 3 };
  assert.equal(ideenProposalStatus(link, [create, link], ideen, STAGES).blocked.key, 'ideenBoard.chat.block.refIdee');
  const applied = { ...create, applied_at: 'x', applied_id: 1 };
  assert.equal(refAppliedIdeeId([applied, link], 1, ideen), 1);
  assert.equal(ideenProposalStatus(link, [applied, link], ideen, STAGES).blocked, null);
  const dup = ideenProposalStatus({ type: 'link_create', idee_id: 2, target_kind: 'beat', target_id: 9 }, [], ideen, STAGES);
  assert.equal(dup.blocked.key, 'ideenBoard.chat.block.linkExists');
});

test('Diff-Zeilen: Stufe, Ort, Text (Wort-Diff)', () => {
  const rows = ideeUpdateRows({
    type: 'idee_update', idee_id: 1,
    fields: { status: 'erledigt', page_id: 5, content: 'Neu Text' },
    before: { status: 'offen', page_id: null, chapter_id: null, content: 'Alt Text' },
    labels: { anchor: 'Der Brief', anchor_before: null },
  });
  assert.deepEqual(rows.map(r => r.key), ['status', 'anchor', 'content']);
  assert.equal(rows[1].after, 'Der Brief');
  assert.ok(Array.isArray(rows[2].diff));
});

test('Prompt: Lese-Werkzeuge existieren im Buch-Chat, Schema deckt die Vorschlags-Werkzeuge', () => {
  const known = new Set(CHAT_TOOLS.map(t => t.name));
  for (const n of chatToolNames('ideen')) assert.ok(known.has(n), n);
  const names = IDEEN_CHAT_PROPOSE_TOOLS.map(t => t.name);
  assert.deepEqual(names, ['propose_idee', 'propose_idee_link', 'final_answer']);
  assert.deepEqual(SCHEMA_IDEEN_CHAT_CLASSIC.properties.vorschlaege.items.properties.werkzeug.enum, ['propose_idee', 'propose_idee_link']);
  const blocks = buildIdeenChatSystemPrompt('Testbuch', {
    mode: 'agent', ideenOutline: '[#1] (offen) «x»', stages: ['offen', 'erledigt'], passages: null,
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ttl, '1h');
  assert.match(blocks[0].text, /ERLEDIGT-CHECK/);
  assert.match(blocks[1].text, /AKTIVE STUFEN DIESES BUCHES.*offen, erledigt/);
  assert.ok(!blocks[1].text.includes('TEXTPASSAGEN'));
  const classic = buildIdeenChatSystemPrompt('Testbuch', { mode: 'classic', passages: [] });
  assert.match(classic[0].text, /ANTWORTFORMAT/);
  assert.match(classic[1].text, /TEXTPASSAGEN/);
});

test('Zusammenführen: Ziel/Quelle weg → blockiert, abgeschlossenes Ziel + offene Quelle → blockiert, Text geändert → stale', () => {
  const merge = (over = {}) => ({ type: 'idee_merge', idee_id: 1, merge_ids: [3], fields: { content: 'Neu' }, before: { content: 'Alt' }, ...over });
  const withThird = [...ideen, { id: 3, content: 'Dublette', status: 'offen', links: [] }];
  assert.deepEqual(ideenProposalStatus(merge(), [], withThird, STAGES), { state: 'open', removed: false, blocked: null, stale: false });
  assert.equal(ideenProposalStatus(merge({ idee_id: 99 }), [], withThird, STAGES).blocked.key, 'ideenBoard.chat.block.ideeGone');
  assert.equal(ideenProposalStatus(merge(), [], ideen, STAGES).blocked.key, 'ideenBoard.chat.block.mergeGone');
  assert.equal(ideenProposalStatus(merge({ idee_id: 2 }), [], withThird, STAGES).blocked.key, 'ideenBoard.chat.block.mergeClosed');
  assert.equal(ideenProposalStatus(merge({ before: { content: 'Anders' } }), [], withThird, STAGES).stale, true);
  assert.equal(ideenProposalStatus(merge({ applied_at: 'x' }), [], [], STAGES).state, 'applied', 'Quellen sind nach dem Übernehmen weg — bleibt übernommen');
  assert.deepEqual(ideeUpdateRows(merge()).map(r => r.key), ['content']);
  assert.deepEqual(ideeUpdateRows(merge({ fields: {} })), []);
  // Aufgehende Idee seit dem Vorschlag geändert → gesperrt (sie würde gelöscht).
  const snap = { content: 'Alt', sources: { 3: 'Dublette' } };
  assert.equal(ideenProposalStatus(merge({ before: snap }), [], withThird, STAGES).blocked, null);
  const edited = withThird.map(i => (i.id === 3 ? { ...i, content: 'Dublette, ergänzt' } : i));
  assert.equal(ideenProposalStatus(merge({ before: snap }), [], edited, STAGES).blocked.key, 'ideenBoard.chat.block.mergeSourceChanged');
});

test('Board-Zusammenführen: Ziel ist eine offene, sonst die älteste; Text ohne Wiederholung', async () => {
  const { mergeTargetOf, mergedContentOf } = await import('../../public/js/book/ideen-board/list.js');
  const a = { id: 5, content: 'Erledigt alt', status: 'erledigt', created_at: '2025-01-01' };
  const b = { id: 6, content: 'Offen  neu', status: 'offen', created_at: '2026-02-01' };
  const c = { id: 7, content: 'offen neu', status: 'in_arbeit', created_at: '2026-01-01' };
  assert.equal(mergeTargetOf([a, b, c]).id, 7);
  assert.equal(mergeTargetOf([a, { ...a, id: 4, created_at: '2025-06-01' }]).id, 5);
  assert.equal(mergedContentOf(c, [b, a]), 'offen neu · Erledigt alt');
});

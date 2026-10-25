'use strict';
// Integration test: Chat-Werkzeug list_werkstatt_drafts (Liste und, mit draft_id/figur_name, Detail).
// Read-only access to draft_figures + werkstatt_runs from the agentic book chat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookChatTools;
let draftFigDb;

test.before(() => {
  ctx = bootstrap();
  bookChatTools = require('../../routes/jobs/chat-tools');
  draftFigDb = require('../../db/draft-figures');
});
test.after(() => { ctx.cleanup(); });

function sampleMindmap(name) {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root', topic: name,
      children: [
        { id: 'steckbrief', topic: 'Steckbrief', children: [
          { id: 'aussehen',    topic: 'Aussehen', children: [
            { id: 'a1', topic: 'rote Haare' },
          ]},
          { id: 'hintergrund', topic: 'Hintergrund' },
        ]},
        { id: 'stimme', topic: '__i18n:werkstatt.tree.stimme__', children: [] },
      ],
    },
  };
}

test('list_werkstatt_drafts: leeres Buch → drafts:[] + hint', () => {
  const BOOK_ID = 7201;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const result = bookChatTools.TOOLS.list_werkstatt_drafts({}, {
    bookId: BOOK_ID, userEmail,
  });
  assert.deepEqual(result.drafts, []);
  assert.match(result.hint, /Werkstatt-Drafts/);
});

test('list_werkstatt_drafts: user-scoped — fremde Drafts unsichtbar', () => {
  const BOOK_ID = 7202;
  const me = 'me@werk.dev';
  const other = 'other@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  draftFigDb.createDraftFigure(BOOK_ID, me,    { name: 'Anna',  mindmap: sampleMindmap('Anna') });
  draftFigDb.createDraftFigure(BOOK_ID, other, { name: 'Boris', mindmap: sampleMindmap('Boris') });

  const result = bookChatTools.TOOLS.list_werkstatt_drafts({}, {
    bookId: BOOK_ID, userEmail: me,
  });
  assert.equal(result.total, 1);
  assert.equal(result.drafts[0].name, 'Anna');
});

test('list_werkstatt_drafts: liefert run-counts + last_run', () => {
  const BOOK_ID = 7203;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap('Anna'),
  });
  draftFigDb.insertWerkstattRun({
    draftId: draft.id, bookId: BOOK_ID, userEmail,
    kind: 'brainstorm', knotenId: 'hintergrund', knotenPfad: 'Anna > Steckbrief > Hintergrund',
    result: { vorschlaege: [{ label: 'X', begruendung: 'y' }] },
    model: 'mock-model',
  });
  draftFigDb.insertWerkstattRun({
    draftId: draft.id, bookId: BOOK_ID, userEmail,
    kind: 'consistency',
    result: { konflikte: [], fazit: 'ok' },
    model: 'mock-model',
  });

  const result = bookChatTools.TOOLS.list_werkstatt_drafts({}, {
    bookId: BOOK_ID, userEmail,
  });
  assert.equal(result.total, 1);
  const item = result.drafts[0];
  assert.deepEqual(item.runs, { brainstorm: 1, consistency: 1 });
  assert.ok(item.last_run);
  assert.equal(item.last_run.kind, 'consistency');
});

test('list_werkstatt_drafts mit Auswahl: per draft_id → mindmap_text + runs', () => {
  const BOOK_ID = 7204;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', archetype: 'protagonist', mindmap: sampleMindmap('Anna'),
    notes: 'wichtige Notiz',
  });
  draftFigDb.insertWerkstattRun({
    draftId: draft.id, bookId: BOOK_ID, userEmail,
    kind: 'brainstorm', knotenId: 'hintergrund', knotenPfad: 'Anna > Steckbrief > Hintergrund',
    result: { vorschlaege: [
      { label: 'Verwitwet', begruendung: 'verstärkt Konflikt' },
      { label: 'Adoptiert', begruendung: 'Wurzelsuche' },
    ]},
    model: 'mock-model',
  });
  draftFigDb.insertWerkstattRun({
    draftId: draft.id, bookId: BOOK_ID, userEmail,
    kind: 'consistency',
    result: {
      konflikte: [{ feld: 'Beruf', schwere: 'stark', problem: 'passt nicht zur Epoche', vorschlag: 'Modistin' }],
      fazit: 'Solider Kern',
    },
    model: 'mock-model',
  });

  const result = bookChatTools.TOOLS.list_werkstatt_drafts(
    { draft_id: draft.id },
    { bookId: BOOK_ID, userEmail },
  );

  assert.equal(result.draft_id, draft.id);
  assert.equal(result.name, 'Anna');
  assert.equal(result.archetype, 'protagonist');
  assert.equal(result.notes, 'wichtige Notiz');
  assert.match(result.mindmap_text, /- Anna/);
  assert.match(result.mindmap_text, /  - Steckbrief/);
  assert.match(result.mindmap_text, /    - Aussehen/);
  assert.match(result.mindmap_text, /      - rote Haare/);
  // i18n-Marker müssen aufgelöst sein (Locale-Default DE)
  assert.ok(!result.mindmap_text.includes('__i18n:'), 'i18n-Marker nicht aufgelöst');

  assert.equal(result.runs.length, 2);
  const brainstormRun = result.runs.find(r => r.kind === 'brainstorm');
  assert.ok(brainstormRun);
  assert.equal(brainstormRun.vorschlaege.length, 2);
  assert.equal(brainstormRun.vorschlaege[0].label, 'Verwitwet');
  assert.equal(brainstormRun.knoten_pfad, 'Anna > Steckbrief > Hintergrund');

  const consistencyRun = result.runs.find(r => r.kind === 'consistency');
  assert.ok(consistencyRun);
  assert.equal(consistencyRun.fazit, 'Solider Kern');
  assert.equal(consistencyRun.konflikte.length, 1);
  assert.equal(consistencyRun.konflikte[0].feld, 'Beruf');
});

test('list_werkstatt_drafts mit Auswahl: per figur_name (substring, case-insensitive)', () => {
  const BOOK_ID = 7205;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna Schmidt', mindmap: sampleMindmap('Anna Schmidt'),
  });

  const result = bookChatTools.TOOLS.list_werkstatt_drafts(
    { figur_name: 'anna' },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(result.name, 'Anna Schmidt');
});

test('list_werkstatt_drafts mit Auswahl: include_runs=false → keine runs', () => {
  const BOOK_ID = 7206;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap('Anna'),
  });
  draftFigDb.insertWerkstattRun({
    draftId: draft.id, bookId: BOOK_ID, userEmail,
    kind: 'brainstorm', knotenId: 'aussehen',
    result: { vorschlaege: [{ label: 'X', begruendung: 'y' }] },
  });

  const result = bookChatTools.TOOLS.list_werkstatt_drafts(
    { draft_id: draft.id, include_runs: false },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(result.runs, undefined);
  assert.equal(result.runs_hint, undefined);
});

test('list_werkstatt_drafts mit Auswahl: cross-user + cross-book Isolation', () => {
  const BOOK_A = 7207;
  const BOOK_B = 7208;
  const me = 'me@werk.dev';
  const other = 'other@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_A, 'A');
  ctx.dbSchema.upsertBookByName(BOOK_B, 'B');

  const foreignDraft = draftFigDb.createDraftFigure(BOOK_A, other, {
    name: 'FremdeFigur', mindmap: sampleMindmap('FremdeFigur'),
  });
  const otherBookDraft = draftFigDb.createDraftFigure(BOOK_B, me, {
    name: 'AndereBuchFigur', mindmap: sampleMindmap('AndereBuchFigur'),
  });

  // foreign user → not found
  const r1 = bookChatTools.TOOLS.list_werkstatt_drafts(
    { draft_id: foreignDraft.id },
    { bookId: BOOK_A, userEmail: me },
  );
  assert.equal(r1.error, 'Werkstatt-Draft nicht gefunden');

  // wrong book → not found (draft id exists, but belongs to BOOK_B)
  const r2 = bookChatTools.TOOLS.list_werkstatt_drafts(
    { draft_id: otherBookDraft.id },
    { bookId: BOOK_A, userEmail: me },
  );
  assert.equal(r2.error, 'Werkstatt-Draft nicht gefunden');
});

test('list_werkstatt_drafts: unbekannte draft_id → error statt Liste', () => {
  const BOOK_ID = 7209;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');

  const result = bookChatTools.TOOLS.list_werkstatt_drafts({ draft_id: 999999 }, {
    bookId: BOOK_ID, userEmail,
  });
  assert.equal(result.error, 'Werkstatt-Draft nicht gefunden');
});

test('executeTool dispatch: list_werkstatt_drafts liefert Liste und, mit draft_id, das Detail', async () => {
  const BOOK_ID = 7210;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');
  const draft = draftFigDb.createDraftFigure(BOOK_ID, userEmail, {
    name: 'Anna', mindmap: sampleMindmap('Anna'),
  });

  const listRes = await bookChatTools.executeTool('list_werkstatt_drafts', {}, {
    bookId: BOOK_ID, userEmail,
  });
  assert.equal(listRes.total, 1);

  const getRes = await bookChatTools.executeTool('list_werkstatt_drafts',
    { draft_id: draft.id },
    { bookId: BOOK_ID, userEmail },
  );
  assert.equal(getRes.name, 'Anna');
});

test('list_werkstatt_drafts mit Auswahl: mehrdeutiger Teilstring → Kandidaten statt Zufallstreffer', () => {
  const BOOK_ID = 7215;
  const userEmail = 'autor@werk.dev';
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'B');
  const ann = draftFigDb.createDraftFigure(BOOK_ID, userEmail, { name: 'Ann', mindmap: sampleMindmap('Ann') });
  draftFigDb.createDraftFigure(BOOK_ID, userEmail, { name: 'Hannah', mindmap: sampleMindmap('Hannah') });
  draftFigDb.createDraftFigure(BOOK_ID, userEmail, { name: 'Annika', mindmap: sampleMindmap('Annika') });

  // Exakter Name gewinnt.
  const exact = bookChatTools.TOOLS.list_werkstatt_drafts({ figur_name: 'ann' }, { bookId: BOOK_ID, userEmail });
  assert.equal(exact.draft_id, ann.id);

  const amb = bookChatTools.TOOLS.list_werkstatt_drafts({ figur_name: 'nn' }, { bookId: BOOK_ID, userEmail });
  assert.equal(amb.errorKey, 'chat.toolError.ambiguousName');
  assert.equal(amb.candidates.length, 3);
});

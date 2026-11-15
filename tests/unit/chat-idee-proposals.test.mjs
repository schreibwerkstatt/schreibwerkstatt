// Ideen-Vorschläge aus Abschnitts-, Buch- und Recherche-Chat (lib/chat-idee-proposals.js):
//  - nur Abschnitte des Session-Buchs; fremde/unbekannte fallen still heraus,
//  - Abschnitts-Chat: ohne page_id der eigene Abschnitt, `ort: 'kapitel'` dessen Kapitel;
//    Buch-Chat: page_id ODER chapter_id Pflicht; Recherche-Chat: nur der Schreibkontext,
//  - Einabschnitts-Kapitel: ein Kapitel-Anker wird zum Abschnitt (ein Ort, ein Anker),
//  - Format = idee_create des Ideen-Chats (geteilter Status-Router),
//  - Deckel, Dubletten, leere Texte.
// Dazu: der Parser reicht `ideen` durch, der Verlauf nennt den Status.
// Änderungen an offenen Ideen (normalizeChatIdeeUpdates, nur Abschnitts-Chat):
//  - nur Ideen aus der Prompt-Liste, je Idee einmal, Deckel,
//  - Stufe nur aktiv + anders, «erledigt» nur mit gefundenem Beleg,
//  - Format = idee_update des Ideen-Chats + scope (Anker der Idee).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';
import { formatIdeenNote } from '../../lib/chat-history-note.js';

const require = createRequire(import.meta.url);
useTmpDb('chat-idee-proposals');

const schema = require('../../db/schema');
const { db } = require('../../db/connection');
const { normalizeChatIdeeProposals, normalizeChatIdeeUpdates, MAX_CHAT_IDEE_PROPOSALS, MAX_CHAT_IDEE_UPDATES } = require('../../lib/chat-idee-proposals');
const { _parseChatResponse } = require('../../routes/jobs/chat/shared');
const { researchIdeeProposals } = require('../../routes/jobs/research-chat-helpers');

const BOOK = 880101;
const OTHER_BOOK = 880102;
const NOW = '2026-01-01T00:00:00.000Z';
schema.upsertBookByName(BOOK, 'Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Anderes Buch');
const CH1 = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Aufbruch').lastInsertRowid;
const CH_FOREIGN = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(OTHER_BOOK, 'Fremd').lastInsertRowid;
const insPage = db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, updated_at) VALUES (?, ?, ?, ?, ?)');
const P1 = 8801011;
const P2 = 8801012;
const P_FOREIGN = 8801021;
insPage.run(P1, BOOK, CH1, 'Der Brief', NOW);
insPage.run(P2, BOOK, null, 'Am Bahnhof', NOW);
insPage.run(P_FOREIGN, OTHER_BOOK, CH_FOREIGN, 'Fremd', NOW);
// CH1 hat zwei Abschnitte — dort bleibt ein Kapitel-Anker ein Kapitel-Anker.
insPage.run(8801013, BOOK, CH1, 'Abfahrt', NOW);
// CH_SOLE: genau ein Abschnitt, keine Unterkapitel. CH_PARENT: ein Abschnitt,
// aber ein Unterkapitel — kein Einabschnitts-Kapitel.
const CH_SOLE = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Heimkehr').lastInsertRowid;
const CH_PARENT = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Teil II').lastInsertRowid;
db.prepare('INSERT INTO chapters (book_id, chapter_name, parent_chapter_id) VALUES (?, ?, ?)').run(BOOK, 'Unterkapitel', CH_PARENT);
const P_SOLE = 8801014;
insPage.run(P_SOLE, BOOK, CH_SOLE, 'Kapitel 2', NOW);
insPage.run(8801015, BOOK, CH_PARENT, 'Vorspann', NOW);

test('Abschnitts-Chat: ohne page_id der eigene Abschnitt, mit page_id ein anderer des Buchs', () => {
  const out = normalizeChatIdeeProposals([
    { inhalt: '  Augenfarbe vereinheitlichen ', begruendung: 'hier grün, Kapitel 2 blau' },
    { inhalt: 'Zeitangabe prüfen', page_id: P2 },
  ], { bookId: BOOK, defaultPageId: P1 });
  assert.deepEqual(out, [
    {
      type: 'idee_create',
      fields: { content: 'Augenfarbe vereinheitlichen', page_id: P1 },
      begruendung: 'hier grün, Kapitel 2 blau',
      labels: { anchor: 'Der Brief', anchor_kind: 'page' },
    },
    {
      type: 'idee_create',
      fields: { content: 'Zeitangabe prüfen', page_id: P2 },
      labels: { anchor: 'Am Bahnhof', anchor_kind: 'page' },
    },
  ]);
});

test('Buch-Chat: ohne page_id kein Vorschlag; fremdes Buch / unbekannter Abschnitt fallen heraus', () => {
  const out = normalizeChatIdeeProposals([
    { inhalt: 'ohne Anker' },
    { inhalt: 'fremd', page_id: P_FOREIGN },
    { inhalt: 'unbekannt', page_id: 999999999 },
    { inhalt: 'gültig', page_id: String(P2) },
  ], { bookId: BOOK });
  assert.equal(out.length, 1);
  assert.equal(out[0].fields.page_id, P2);
  assert.equal(out[0].fields.content, 'gültig');
});

test('Abschnitts-Chat: ort=kapitel → Kapitel des eigenen Abschnitts; ohne Kapitel der Abschnitt', () => {
  const [a] = normalizeChatIdeeProposals([{ inhalt: 'Zeitlinie prüfen', ort: 'kapitel' }], { bookId: BOOK, defaultPageId: P1 });
  assert.deepEqual(a.fields, { content: 'Zeitlinie prüfen', chapter_id: CH1 });
  assert.deepEqual(a.labels, { anchor: 'Aufbruch', anchor_kind: 'chapter' });
  const [b] = normalizeChatIdeeProposals([{ inhalt: 'Solo', ort: 'kapitel' }], { bookId: BOOK, defaultPageId: P2 });
  assert.deepEqual(b.fields, { content: 'Solo', page_id: P2 });
  const [c] = normalizeChatIdeeProposals([{ inhalt: 'Abschnitt', ort: 'abschnitt' }], { bookId: BOOK, defaultPageId: P1 });
  assert.deepEqual(c.fields, { content: 'Abschnitt', page_id: P1 });
});

test('Buch-Chat: chapter_id als Anker, page_id hat Vorrang, fremdes Kapitel fällt heraus', () => {
  const out = normalizeChatIdeeProposals([
    { inhalt: 'Kapitel', chapter_id: CH1 },
    { inhalt: 'Beides', page_id: P2, chapter_id: CH1 },
    { inhalt: 'Fremdes Kapitel', chapter_id: CH_FOREIGN },
    { inhalt: 'Gleicher Text, anderer Ort', page_id: P1 },
    { inhalt: 'gleicher text, anderer ort', chapter_id: CH1 },
  ], { bookId: BOOK });
  assert.deepEqual(out.map(p => p.fields), [
    { content: 'Kapitel', chapter_id: CH1 },
    { content: 'Beides', page_id: P2 },
    { content: 'Gleicher Text, anderer Ort', page_id: P1 },
    { content: 'gleicher text, anderer ort', chapter_id: CH1 },
  ]);
  assert.equal(out[0].labels.anchor_kind, 'chapter');
});

test('Recherche-Chat: Anker nur aus dem Schreibkontext, Modell-IDs fallen weg', () => {
  const raw = [
    { inhalt: 'Datum prüfen', page_id: P2, chapter_id: CH_FOREIGN },
    { inhalt: 'Kapitelweit', ort: 'kapitel' },
  ];
  // Abschnitt als Kontext: dieser Abschnitt, mit ort=kapitel dessen Kapitel — die
  // genannte page_id (P2) ist geraten und zählt nicht.
  assert.deepEqual(researchIdeeProposals(raw, { kind: 'page', id: P1 }, BOOK).map(p => p.fields), [
    { content: 'Datum prüfen', page_id: P1 },
    { content: 'Kapitelweit', chapter_id: CH1 },
  ]);
  // Kapitel als Kontext: alles am Kapitel, `ort` egal.
  assert.deepEqual(researchIdeeProposals(raw, { kind: 'chapter', id: CH1 }, BOOK).map(p => p.fields), [
    { content: 'Datum prüfen', chapter_id: CH1 },
    { content: 'Kapitelweit', chapter_id: CH1 },
  ]);
  // Einabschnitts-Kapitel: Kapitel-Kontext wie ort=kapitel am einzigen Abschnitt
  // landen beide am Abschnitt (lib/idee-anchor.js) — und sind derselbe Ort.
  assert.deepEqual(researchIdeeProposals([{ inhalt: 'Kapitelkontext' }], { kind: 'chapter', id: CH_SOLE }, BOOK).map(p => p.fields), [
    { content: 'Kapitelkontext', page_id: P_SOLE },
  ]);
  assert.deepEqual(researchIdeeProposals([{ inhalt: 'Kapitelweit', ort: 'kapitel' }], { kind: 'page', id: P_SOLE }, BOOK).map(p => p.fields), [
    { content: 'Kapitelweit', page_id: P_SOLE },
  ]);
  // Ohne Kontext, mit fremdem Kontext oder ohne Liste: keine Ideen.
  assert.deepEqual(researchIdeeProposals(raw, null, BOOK), []);
  assert.deepEqual(researchIdeeProposals(raw, { kind: 'page', id: P_FOREIGN }, BOOK), []);
  assert.deepEqual(researchIdeeProposals(undefined, { kind: 'page', id: P1 }, BOOK), []);
});

test('Einabschnitts-Kapitel: Kapitel-Anker wird zum Abschnitt, sonst bleibt er', () => {
  const out = normalizeChatIdeeProposals([
    { inhalt: 'Kapitel direkt', chapter_id: CH_SOLE },
    { inhalt: 'Über ort', ort: 'kapitel' },
    { inhalt: 'Mit Unterkapitel', chapter_id: CH_PARENT },
  ], { bookId: BOOK, defaultPageId: P_SOLE });
  assert.deepEqual(out.map(p => p.fields), [
    { content: 'Kapitel direkt', page_id: P_SOLE },
    { content: 'Über ort', page_id: P_SOLE },
    { content: 'Mit Unterkapitel', chapter_id: CH_PARENT },
  ]);
  assert.deepEqual(out[0].labels, { anchor: 'Kapitel 2', anchor_kind: 'page' });
});

test('Einabschnitts-Kapitel: dieselbe Idee über Kapitel und Abschnitt ist eine Dublette', () => {
  const out = normalizeChatIdeeProposals([
    { inhalt: 'Zeit prüfen', chapter_id: CH_SOLE },
    { inhalt: 'Zeit prüfen', page_id: P_SOLE },
  ], { bookId: BOOK });
  assert.equal(out.length, 1);
});

test('Leere Texte, Nicht-Objekte, Dubletten, Deckel', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ inhalt: `Punkt ${i}`, page_id: P1 }));
  const out = normalizeChatIdeeProposals([
    null, 'x', { inhalt: '   ' }, { inhalt: 'Doppelt', page_id: P1 }, { inhalt: 'doppelt', page_id: P1 }, ...many,
  ], { bookId: BOOK });
  assert.equal(out.length, MAX_CHAT_IDEE_PROPOSALS);
  assert.equal(out.filter(p => p.fields.content.toLowerCase() === 'doppelt').length, 1);
  assert.deepEqual(normalizeChatIdeeProposals('kein Array', { bookId: BOOK }), []);
  assert.deepEqual(normalizeChatIdeeProposals([{ inhalt: 'x', page_id: P1 }], {}), []);
});

test('Parser reicht `ideen` roh durch, Fallback liefert leeres Array', () => {
  const ok = _parseChatResponse(JSON.stringify({ antwort: 'A', vorschlaege: [], titel_varianten: [], ideen: [{ inhalt: 'X' }] }));
  assert.deepEqual(ok.ideen, [{ inhalt: 'X' }]);
  assert.deepEqual(_parseChatResponse('nur Prosa ohne JSON').ideen, []);
});

test('Verlauf nennt den Status früherer Ideen-Vorschläge', () => {
  const txt = formatIdeenNote([
    { type: 'idee_create', fields: { content: 'Erfasst' }, applied_at: NOW },
    { type: 'idee_create', fields: { content: 'Weg' }, status: 'discarded' },
    { type: 'idee_create', fields: { content: 'Offen' } },
    { type: 'link_create' },
  ]);
  assert.match(txt, /1\. \[als Idee erfasst\] Erfasst/);
  assert.match(txt, /2\. \[verworfen\] Weg/);
  assert.match(txt, /3\. \[offen\] Offen/);
  assert.equal(formatIdeenNote(undefined), '');
});

const IDEEN = [
  { id: 1, scope: 'page', content: 'Brief einbauen', status: 'offen' },
  { id: 2, scope: 'chapter', content: 'Zeitlinie prüfen', status: 'in_arbeit' },
];
const UPD_OPTS = {
  ideen: IDEEN, stages: ['offen', 'in_arbeit', 'erledigt'], pageId: P1, pageName: 'Der Brief', chapterId: CH1,
  belegOk: (t) => t === 'Sie las den Brief zweimal.',
};

test('Ideen-Änderung: «erledigt» mit gefundenem Beleg → idee_update samt Beleg und Anker', () => {
  const { proposals, dropped } = normalizeChatIdeeUpdates([
    { idee_id: 1, inhalt: '', status: 'erledigt', beleg: 'Sie las den Brief zweimal.', begruendung: 'Brief steht jetzt drin' },
  ], UPD_OPTS);
  assert.equal(dropped, 0);
  assert.deepEqual(proposals, [{
    type: 'idee_update', idee_id: 1,
    fields: { status: 'erledigt' }, before: { status: 'offen' },
    beleg: { text: 'Sie las den Brief zweimal.', page_id: P1 },
    begruendung: 'Brief steht jetzt drin',
    scope: { kind: 'page', id: P1 },
    labels: { idee: 'Brief einbauen', beleg_page: 'Der Brief' },
  }]);
});

test('Ideen-Änderung: «erledigt» ohne oder mit nicht gefundenem Beleg fällt weg', () => {
  const { proposals, dropped } = normalizeChatIdeeUpdates([
    { idee_id: 1, status: 'erledigt', beleg: '' },
    { idee_id: 2, status: 'erledigt', beleg: 'Steht nirgends.' },
  ], UPD_OPTS);
  assert.deepEqual(proposals, []);
  assert.equal(dropped, 2);
});

test('Ideen-Änderung: Text ändern an Kapitel-Idee, Beleg an anderer Stufe nur wenn gefunden', () => {
  const { proposals } = normalizeChatIdeeUpdates([
    { idee_id: 2, inhalt: 'Zeitlinie Kapitel 1–3 prüfen', status: null, beleg: 'erfunden' },
  ], UPD_OPTS);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].fields, { content: 'Zeitlinie Kapitel 1–3 prüfen' });
  assert.deepEqual(proposals[0].before, { content: 'Zeitlinie prüfen' });
  assert.deepEqual(proposals[0].scope, { kind: 'chapter', id: CH1 });
  assert.equal(proposals[0].beleg, undefined);
});

test('Ideen-Änderung: fremde Idee, abgeschaltete/gleiche Stufe, Dublette, No-Op, Deckel', () => {
  const { proposals, dropped } = normalizeChatIdeeUpdates([
    { idee_id: 99, status: 'in_arbeit' },               // nicht im Prompt
    { idee_id: 1, status: 'verworfen' },                // im Buch abgeschaltet
    { idee_id: 2, status: 'in_arbeit', inhalt: 'Zeitlinie prüfen' }, // keine Änderung
    { idee_id: 1, status: 'in_arbeit' },
    { idee_id: 1, status: 'offen', inhalt: 'Anders' },  // zweiter Vorschlag zu #1
  ], UPD_OPTS);
  assert.deepEqual(proposals.map(p => [p.idee_id, p.fields]), [[1, { status: 'in_arbeit' }]]);
  assert.equal(dropped, 4);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, scope: 'page', content: `I${i}`, status: 'offen' }));
  const capped = normalizeChatIdeeUpdates(many.map(i => ({ idee_id: i.id, status: 'in_arbeit' })), { ...UPD_OPTS, ideen: many });
  assert.equal(capped.proposals.length, MAX_CHAT_IDEE_UPDATES);
  assert.deepEqual(normalizeChatIdeeUpdates('x', UPD_OPTS), { proposals: [], dropped: 0 });
});

test('Parser reicht `ideen_aenderungen` roh durch', () => {
  const ok = _parseChatResponse(JSON.stringify({ antwort: 'A', vorschlaege: [], titel_varianten: [], ideen: [], ideen_aenderungen: [{ idee_id: 1 }] }));
  assert.deepEqual(ok.ideen_aenderungen, [{ idee_id: 1 }]);
});

test('Verlauf nennt Ideen-Änderungen mit Status', () => {
  const txt = formatIdeenNote([
    { type: 'idee_update', idee_id: 7, fields: { status: 'erledigt' }, applied_at: NOW },
    { type: 'idee_update', idee_id: 8, fields: { content: 'Neu' }, status: 'discarded' },
  ]);
  assert.match(txt, /1\. \[übernommen\] Änderung an Idee #7: Stufe → erledigt/);
  assert.match(txt, /2\. \[verworfen\] Änderung an Idee #8: Text → Neu/);
});

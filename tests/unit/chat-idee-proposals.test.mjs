// Ideen-Vorschläge aus Abschnitts- und Buch-Chat (lib/chat-idee-proposals.js):
//  - nur Abschnitte des Session-Buchs; fremde/unbekannte fallen still heraus,
//  - Abschnitts-Chat: ohne page_id der eigene Abschnitt, `ort: 'kapitel'` dessen Kapitel;
//    Buch-Chat: page_id ODER chapter_id Pflicht,
//  - Format = idee_create des Ideen-Chats (geteilter Status-Router),
//  - Deckel, Dubletten, leere Texte.
// Dazu: der Parser reicht `ideen` durch, der Verlauf nennt den Status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';
import { formatHistoryIdeen } from '../../public/js/prompts/page-chat.js';

const require = createRequire(import.meta.url);
useTmpDb('chat-idee-proposals');

const schema = require('../../db/schema');
const { db } = require('../../db/connection');
const { normalizeChatIdeeProposals, MAX_CHAT_IDEE_PROPOSALS } = require('../../lib/chat-idee-proposals');
const { _parseChatResponse } = require('../../routes/jobs/chat/shared');

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
  const txt = formatHistoryIdeen([
    { type: 'idee_create', fields: { content: 'Erfasst' }, applied_at: NOW },
    { type: 'idee_create', fields: { content: 'Weg' }, status: 'discarded' },
    { type: 'idee_create', fields: { content: 'Offen' } },
    { type: 'link_create' },
  ]);
  assert.match(txt, /1\. \[als Idee erfasst\] Erfasst/);
  assert.match(txt, /2\. \[verworfen\] Weg/);
  assert.match(txt, /3\. \[offen\] Offen/);
  assert.equal(formatHistoryIdeen(undefined), '');
});

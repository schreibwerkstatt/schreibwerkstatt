// Abschnitts-Chat, Figuren: Kapitel ohne Figuren-Zuordnung fällt auf das ganze
// Buch zurück (Block 1, kapitel-stabil), und Figuren, die Abschnitt oder Frage
// beim Namen nennen, aber nicht im Block stehen, kommen als Stammzeile dazu
// (Abschnitt → Block 2, Frage → Präambel). Anlass: eine bereits eingeführte
// Nebenfigur galt als «muss vorher eingeführt werden», weil das neue Kapitel
// keine Figuren zugeordnet hatte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');
const { pageChatFigurenHead, pageChatFigurenNachtrag } = await import('../../public/js/prompts/page-chat.js');
const require = createRequire(import.meta.url);
const { chapterFiguren, figurenNachtrag, mentionedFigureIds } = require('../../routes/jobs/chat/page-chat-figuren.js');

const outline = [
  { type: 'chapter', id: 10, name: 'Kapitel 1' },
  { type: 'page', id: 100, name: 'A', chapter_id: 10 },
  { type: 'chapter', id: 30, name: 'Kapitel 3' },
  { type: 'chapter', id: 20, name: 'Kapitel 2' },
];
const namen = [
  { id: 1, fig_id: 'fig_1', name: 'Liliane Berg', kurzname: 'Lilli', typ: 'hauptfigur', erste_erwaehnung: 'Kapitel 1', chapter_ids: [10] },
  { id: 2, fig_id: 'fig_2', name: 'Sarah', kurzname: 'Sarah', typ: 'nebenfigur', erste_erwaehnung: 'Kapitel 2', chapter_ids: [30, 20] },
  { id: 3, fig_id: 'fig_3', name: 'Tom Keller', kurzname: 'Tom', typ: 'hauptfigur', chapter_ids: [] },
];

test('chapterFiguren: Kapitel mit Zuordnung → nur Kapitel', () => {
  const r = chapterFiguren((ch) => (ch === 10 ? [{ id: 'fig_1' }] : [{ id: 'fig_1' }, { id: 'fig_2' }]), 10);
  assert.equal(r.scope, 'kapitel');
  assert.equal(r.figuren.length, 1);
});

test('chapterFiguren: Kapitel ohne Zuordnung → alle Figuren des Buchs', () => {
  const r = chapterFiguren((ch) => (ch === 40 ? [] : [{ id: 'fig_1' }, { id: 'fig_2' }]), 40);
  assert.equal(r.scope, 'fallback');
  assert.equal(r.figuren.length, 2);
});

test('chapterFiguren: Abschnitt ohne Kapitel → Buch', () => {
  const r = chapterFiguren(() => [{ id: 'fig_1' }], null);
  assert.equal(r.scope, 'buch');
});

test('figurenNachtrag: Frage nennt fehlende Figur → Stammzeile mit Kapiteln in Lesereihenfolge', () => {
  const r = figurenNachtrag({
    namen, blockFiguren: [{ id: 'fig_1' }], outline,
    pageText: 'Lilli sass am Fenster.', question: 'Soll ich Sarah kurz vorher erwähnen?',
  });
  assert.deepEqual(r.abschnitt, []);
  assert.equal(r.frage.length, 1);
  assert.equal(r.frage[0].name, 'Sarah');
  assert.deepEqual(r.frage[0].kapitel, ['Kapitel 3', 'Kapitel 2']); // Gliederungs-Reihenfolge, nicht ID
  assert.equal(r.frage[0].erste_erwaehnung, 'Kapitel 2');
});

test('figurenNachtrag: Abschnitt vor Frage, keine Doppelung, Block-Figuren nie', () => {
  const r = figurenNachtrag({
    namen, blockFiguren: [{ id: 'fig_1' }], outline,
    pageText: 'Tom rief an. Sarah auch.', question: 'Was ist mit Sarah und Lilli?',
  });
  assert.deepEqual(r.abschnitt.map(f => f.name), ['Sarah', 'Tom Keller']);
  assert.deepEqual(r.frage, []);
});

test('Namensabgleich: Vorname ohne Kurzname trifft, beschreibende Namensteile nicht', () => {
  const figs = [
    { id: 7, fig_id: 'fig_7', name: 'Sarah Müller', kurzname: null, chapter_ids: [] },
    { id: 8, fig_id: 'fig_8', name: "Tobias' Mutter", kurzname: "Tobias' Mutter", chapter_ids: [] },
    { id: 9, fig_id: 'fig_9', name: 'Rektor der Kantonsschule Olten', kurzname: 'Rektor', chapter_ids: [] },
    { id: 10, fig_id: 'fig_10', name: 'Charlotte', kurzname: 'Lotte', weitere_namen: '["Lotti"]', chapter_ids: [] },
  ];
  const ids = mentionedFigureIds('Sarah rief an. Die Mutter kam aus Olten. Lotti schlief.', figs);
  assert.deepEqual([...ids].sort(), [10, 7]);
  assert.deepEqual([...mentionedFigureIds('Der Rektor wartete. Tobias\' Mutter auch.', figs)].sort(), [8, 9]);
  // Nachname allein trifft nicht mehr (zu viele Fehltreffer bei beschreibenden Namen).
  const r = figurenNachtrag({ namen, blockFiguren: [], outline, pageText: '', question: 'Wie wirkt Keller hier?' });
  assert.deepEqual(r.frage, []);
});

test('Prompt: Kopf sagt Kapitel bzw. Rückfall, sonst Standardkopf', () => {
  assert.match(pageChatFigurenHead('kapitel').join('\n'), /FIGUREN DIESES KAPITELS[\s\S]*das Buch hat weitere/);
  assert.match(pageChatFigurenHead('fallback').join('\n'), /noch keine Figuren zugeordnet/);
  assert.equal(pageChatFigurenHead('buch'), null);
  const fig = [{ id: 'fig_1', name: 'Lilli', typ: 'hauptfigur', kapitel: ['Kapitel 1'] }];
  const k = buildChatSystemPrompt('A', 'Text', fig, null, null, null, null, null, { figurenScope: 'kapitel' });
  assert.match(k[0].text, /=== FIGUREN DIESES KAPITELS ===/);
  const b = buildChatSystemPrompt('A', 'Text', fig, null, null, null, null, null, {});
  assert.match(b[0].text, /=== FIGUREN DES BUCHS ===/);
});

test('Prompt: Abschnitts-Nachtrag steht in Block 2, nicht im Kapitel-Präfix', () => {
  const rows = [{ name: 'Sarah', kurzname: 'Sarah', typ: 'nebenfigur', kapitel: ['Kapitel 2'] }];
  const blocks = buildChatSystemPrompt('A', 'Sarah kam.', [], null, null, null, null, null, { abschnittFiguren: rows });
  assert.ok(!blocks[0].text.includes('WEITERE FIGUREN'));
  assert.match(blocks[1].text, /WEITERE FIGUREN, DIE DIESER ABSCHNITT NENNT[\s\S]*"name":"Sarah","typ":"nebenfigur","kapitel":\["Kapitel 2"\]/);
});

test('Prompt: Frage-Nachtrag leer → keine Zeilen', () => {
  assert.deepEqual(pageChatFigurenNachtrag([], 'frage'), []);
  assert.match(pageChatFigurenNachtrag([{ name: 'Sarah', kapitel: [] }], 'frage')[0], /FIGUREN AUS DER FRAGE/);
});

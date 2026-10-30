// Abschnitts-Chat, Titelfragen: Abschnittstitel des Buchs als Kontext
// (buildBookTitlesBlock in Block 1) und Markierung von Varianten, die einem
// anderen Abschnittstitel gleichen (titelCollisions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildChatSystemPrompt, normalizeTitle } = await import('../../public/js/prompts.js');
const { buildBookTitlesBlock } = await import('../../public/js/prompts/page-chat.js');
const require = createRequire(import.meta.url);
const { titelCollisions } = require('../../routes/jobs/chat/page-chat-verify.js');

const titles = [
  { id: 1, name: "I'd stand alone in a room", chapter: 'Teil 1' },
  { id: 2, name: 'I would not delete WhatsApps', chapter: 'Teil 1' },
  { id: 3, name: 'I would smash that car', chapter: 'Teil 2' },
];

test('Titel-Block: Lesereihenfolge, Kapitel, aktueller Abschnitt markiert, Regel zum Muster', () => {
  const out = buildBookTitlesBlock(titles, 2);
  assert.ok(out.startsWith('=== ABSCHNITTSTITEL DES BUCHS (Lesereihenfolge) ==='));
  assert.ok(out.indexOf("I'd stand alone") < out.indexOf('smash that car'));
  assert.ok(out.includes('- [Teil 1] I would not delete WhatsApps ← dieser Abschnitt'));
  assert.ok(out.includes('Muster der bestehenden Titel'));
});

test('Titel-Block: weniger als zwei Abschnitte → kein Block', () => {
  assert.equal(buildBookTitlesBlock([titles[0]], 1), '');
  assert.equal(buildBookTitlesBlock(null, 1), '');
});

test('Titel-Block: über dem Deckel erst ohne Kapitel, dann ausgewiesen gekürzt', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Titel Nummer ${i}`, chapter: 'Ein recht langer Kapitelname' }));
  const out = buildBookTitlesBlock(many, null, { maxChars: 2000 });
  assert.ok(!out.includes('[Ein recht langer'));
  assert.match(out, /\(… \d+ weitere Abschnitte nicht aufgeführt\)/);
});

test('System-Prompt: Titel-Block im buch-stabilen Block 1, nicht im Seiten-Block', () => {
  const blocks = buildChatSystemPrompt('Seite', 'Inhalt.', [], null, null, null, null, null, { bookTitles: titles, currentPageId: 1 });
  assert.ok(blocks[0].text.includes('ABSCHNITTSTITEL DES BUCHS'));
  assert.ok(!blocks[1].text.includes('ABSCHNITTSTITEL DES BUCHS'));
});

test('Lektorats-Block: Szenen-Bewertungen gehen mit', () => {
  const lektorat = { checked_at: '2026-10-19T10:00:00Z', fehler: [], szenen: [{ titel: 'WG', wertung: 'mittel', kommentar: 'verliert Spannung' }] };
  const out = buildChatSystemPrompt('Seite', 'Inhalt.', [], null, null, null, null, lektorat).map(b => b.text).join('\n');
  assert.ok(out.includes('LETZTES LEKTORAT DIESES ABSCHNITTS'));
  assert.ok(out.includes('verliert Spannung'));
});

test('Kollision: gleicher Titel (Gross/Klein, Satzzeichen) eines ANDEREN Abschnitts', () => {
  const v = ['I would smash that car!', "I'd stand alone in a room", 'Something new'];
  assert.deepEqual(titelCollisions(v, titles, 1, normalizeTitle), [{ i: 0, page_id: 3, name: 'I would smash that car' }]);
});

test('Kollision: keine Varianten oder keine Titel → leer', () => {
  assert.deepEqual(titelCollisions([], titles, 1, normalizeTitle), []);
  assert.deepEqual(titelCollisions(['x'], null, 1, normalizeTitle), []);
});

// Abschnitts-Chat, Titelfragen: Abschnittstitel des Buchs als Kontext
// (buildBookTitlesBlock in Block 1) und Markierung von Varianten, die einem
// anderen Abschnittstitel gleichen (titelCollisions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { buildChatSystemPrompt, normalizeTitle } = await import('../../public/js/prompts.js');
const { buildBookTitlesBlock, buildCurrentTitleLine } = await import('../../public/js/prompts/page-chat.js');
const require = createRequire(import.meta.url);
const { titelCollisions } = require('../../routes/jobs/chat/page-chat-verify.js');

const titles = [
  { id: 1, name: "I'd stand alone in a room", chapter: 'Teil 1' },
  { id: 2, name: 'I would not delete WhatsApps', chapter: 'Teil 1' },
  { id: 3, name: 'I would smash that car', chapter: 'Teil 2' },
];

test('Titel-Block: Lesereihenfolge, Kapitel, Regel zum Muster, keine Markierung', () => {
  const out = buildBookTitlesBlock(titles);
  assert.ok(out.startsWith('=== ABSCHNITTSTITEL DES BUCHS (Lesereihenfolge) ==='));
  assert.ok(out.indexOf("I'd stand alone") < out.indexOf('smash that car'));
  assert.ok(out.includes('- [Teil 1] I would not delete WhatsApps\n'));
  assert.ok(!out.includes('dieser Abschnitt'));
  assert.ok(out.includes('Muster der bestehenden Titel'));
});

test('Titel-Block: weniger als zwei Abschnitte → kein Block', () => {
  assert.equal(buildBookTitlesBlock([titles[0]]), '');
  assert.equal(buildBookTitlesBlock(null), '');
});

test('Stellung des Abschnitts: Nummer, Kapitel, Nachbarn; Ränder; unbekannt → leer', () => {
  assert.equal(buildCurrentTitleLine(titles, 2),
    "Stellung in der Titelliste: Nr. 2 von 3, Kapitel Teil 1; nach «I'd stand alone in a room», vor «I would smash that car».");
  assert.match(buildCurrentTitleLine(titles, 1), /Nr\. 1 von 3.*erster Abschnitt, vor/);
  assert.match(buildCurrentTitleLine(titles, 3), /nach «I would not delete WhatsApps», letzter Abschnitt\.$/);
  assert.equal(buildCurrentTitleLine(titles, 99), '');
  assert.equal(buildCurrentTitleLine([titles[0]], 1), '');
});

test('Titel-Block: über dem Deckel erst ohne Kapitel, dann ausgewiesen gekürzt', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Titel Nummer ${i}`, chapter: 'Ein recht langer Kapitelname' }));
  const out = buildBookTitlesBlock(many, { maxChars: 2000 });
  assert.ok(!out.includes('[Ein recht langer'));
  assert.match(out, /\(… \d+ weitere Abschnitte nicht aufgeführt\)/);
});

test('System-Prompt: Titel-Block im buch-stabilen Block 1, nicht im Seiten-Block', () => {
  const blocks = buildChatSystemPrompt('Seite', 'Inhalt.', [], null, null, null, null, null, { bookTitles: titles, currentPageId: 1 });
  assert.ok(blocks[0].text.includes('ABSCHNITTSTITEL DES BUCHS'));
  assert.ok(!blocks[1].text.includes('ABSCHNITTSTITEL DES BUCHS'));
  assert.ok(blocks[1].text.includes('Stellung in der Titelliste: Nr. 1 von 3'));
});

// Prompt-Cache: Block 1 ist der geteilte Präfix aller Abschnitts-Chats eines Kapitels.
// Steht darin etwas Abschnitts-Spezifisches, schreibt jeder Seitenwechsel ihn neu.
test('System-Prompt: Block 1 byte-gleich für zwei Abschnitte desselben Kapitels', () => {
  const a = buildChatSystemPrompt('Seite A', 'Text A.', [], null, null, null, null, null, { bookTitles: titles, currentPageId: 1 });
  const b = buildChatSystemPrompt('Seite B', 'Text B.', [], null, null, null, null, null, { bookTitles: titles, currentPageId: 2 });
  assert.equal(a[0].text, b[0].text);
  assert.notEqual(a[1].text, b[1].text);
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

// Abschnittstext in den Chat-Prompts als Tags (public/js/prompts/book-text-format.js):
// aktueller Abschnitt im Abschnitts-Chat, Kontext-Passagen ohne Sprungziele,
// Treffer ohne Abschnitt als <treffer>.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildChatSystemPrompt } = await import('../../public/js/prompts.js');
const { buildPageChatBookContext } = await import('../../public/js/prompts/page-chat.js');
const { formatPassage, buildBookChatPreContext } = await import('../../public/js/prompts/chat-pre-context.js');

test('Abschnitts-Chat: aktueller Abschnitt als <abschnitt> mit Absätzen', () => {
  const blocks = buildChatSystemPrompt('Tom & Jerry', 'Erster.\n\nZweiter.', [], null);
  const page = blocks[blocks.length - 1].text;
  assert.match(page, /<abschnitt titel="Tom & Jerry" aktuell="ja">\nErster\.\n\nZweiter\.\n<\/abschnitt>/);
  // Vorschlags-Regel bindet `original` an genau dieses Tag, nicht an Kontext-Passagen.
  assert.match(blocks.map(b => b.text).join('\n'), /original stammt ausschliesslich aus dem aktuellen Abschnitt \(<abschnitt aktuell="ja">\)/);
  assert.doesNotMatch(page, /=== ABSCHNITTSINHALT ===/);
});

test('Abschnitts-Chat: Kontext aus anderen Teilen ohne Sprungziel, Treffer getaggt', () => {
  const out = buildPageChatBookContext([
    { kind: 'page', entity_id: 3, title: 'Vorher', chapter_path: 'K1', rank: 1, similarity: 0.7, text: 'Text.' },
    { kind: 'figure', entity_id: 9, title: 'Lena', text: 'Schwester.' },
  ]);
  assert.match(out, /<abschnitt titel="Vorher" kapitel="K1">\nText\.\n<\/abschnitt>/);
  assert.match(out, /<treffer art="figur" titel="Lena">\nSchwester\.\n<\/treffer>/);
  assert.doesNotMatch(out, /entity_id|rang=/, 'der Abschnitts-Chat hat keine Werkzeuge');
  assert.match(out, /`original` nie aus einem `<abschnitt>` dieses Blocks/);
  assert.doesNotMatch(out, /aktuell="ja">\n/, 'Kontext-Passagen tragen die aktuell-Marke nicht');
});

test('formatPassage: Treffer ohne Abschnitt tragen art, Sprungziel und Relevanz', () => {
  assert.equal(
    formatPassage({ kind: 'scene', entity_id: 5, title: 'Abschied', chapter_path: 'K2', rank: 2, similarity: 0.4, text: ' Bahnhof. ' }),
    '<treffer art="szene" titel="Abschied" entity_id="5" kapitel="K2" rang="2" aehnlichkeit="0.4">\nBahnhof.\n</treffer>',
  );
});

test('Buch-Chat Erst-Kontext: Verweis auf <abschnitt>-Treffer für get_pages', () => {
  const text = buildBookChatPreContext([{ kind: 'page', entity_id: 1, title: 'A', text: 'x' }], null, { toolNames: ['get_pages', 'quote_passage'] });
  assert.match(text, /`entity_id` eines `<abschnitt>`-Treffers geht als page_id/);
});

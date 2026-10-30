'use strict';
// Unit-Tests für lib/ai/tool-translate.js — die Übersetzung zwischen der kanonischen
// Tool-Use-Form der App (Anthropic) und OpenAI-Function-Calling. Reine Funktionen,
// kein Netz, keine DB.
// Dazu ein Drift-Gate auf den Slim-Werkzeugsatz des Buch-Chats.
// Lauf: `node --test tests/unit/ai-tool-translate.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const {
  toolsToOpenAI, messagesToOpenAI, toolCallsToCanonical, salvageTextToolCalls,
} = require('../../lib/ai/tool-translate');

test('toolsToOpenAI: input_schema wird parameters, Form bleibt OpenAI-konform', () => {
  const out = toolsToOpenAI([
    { name: 'list_chapters', description: 'Kapitelliste', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'ohne_schema' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    type: 'function',
    function: { name: 'list_chapters', description: 'Kapitelliste', parameters: { type: 'object', properties: {}, required: [] } },
  });
  // Ohne input_schema trotzdem ein gültiges leeres Objekt-Schema (nicht undefined):
  // ein fehlendes `parameters` lehnen manche Endpunkte mit 400 ab.
  assert.deepEqual(out[1].function.parameters, { type: 'object', properties: {}, required: [] });
  assert.equal('description' in out[1].function, false);
});

test('messagesToOpenAI: String-Turns unverändert, tool_use → tool_calls, tool_result → role:tool', () => {
  const out = messagesToOpenAI([
    { role: 'user', content: 'Wie alt ist Anna?' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Ich schaue nach.' },
      { type: 'tool_use', id: 'abc123456', name: 'search_passages', input: { pattern: 'Anna' } },
      { type: 'tool_use', id: 'def123456', name: 'list_figures', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'abc123456', content: '{"hits":[]}' },
      { type: 'tool_result', tool_use_id: 'def123456', content: '{"figuren":[]}' },
    ] },
  ]);
  assert.deepEqual(out[0], { role: 'user', content: 'Wie alt ist Anna?' });
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'Ich schaue nach.');
  assert.equal(out[1].tool_calls.length, 2);
  assert.deepEqual(out[1].tool_calls[0], {
    id: 'abc123456', type: 'function',
    function: { name: 'search_passages', arguments: '{"pattern":"Anna"}' },
  });
  // Jedes tool_result ist eine EIGENE Nachricht mit tool_call_id — ohne die
  // Zuordnung verliert der Endpunkt den Bezug Aufruf↔Ergebnis.
  assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'abc123456', content: '{"hits":[]}' });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'def123456', content: '{"figuren":[]}' });
  assert.equal(out.length, 4);
});

test('messagesToOpenAI: assistant ohne tool_use trägt kein tool_calls-Feld', () => {
  const out = messagesToOpenAI([{ role: 'assistant', content: [{ type: 'text', text: 'Nur Prosa.' }] }]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'Nur Prosa.' }]);
});

test('messagesToOpenAI: thinking wird reasoning_content, server_tool_use fällt weg', () => {
  const out = messagesToOpenAI([{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'überlegt' },
    { type: 'server_tool_use', id: 'srv', name: 'web_search', input: { query: 'x' } },
    { type: 'text', text: 'sichtbar' },
  ] }]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'sichtbar', reasoning_content: 'überlegt' }]);
});

test('toolCallsToCanonical: Argument-JSON wird geparst, Text bleibt eigener Block', () => {
  const { toolUses, rawContentBlocks } = toolCallsToCanonical('Moment.', [
    { id: 'tc1', name: 'get_pages', arguments: '{"page_ids":[3,4]}' },
  ]);
  assert.deepEqual(toolUses, [{ id: 'tc1', name: 'get_pages', input: { page_ids: [3, 4] } }]);
  assert.deepEqual(rawContentBlocks[0], { type: 'text', text: 'Moment.' });
  assert.equal(rawContentBlocks[1].type, 'tool_use');
});

test('toolCallsToCanonical: kaputtes Argument-JSON gibt leeren Input + parseError statt zu werfen', () => {
  const { toolUses } = toolCallsToCanonical('', [{ id: 'tc1', name: 'get_pages', arguments: '{"page_ids":[3,' }]);
  assert.deepEqual(toolUses[0].input, {});
  assert.ok(toolUses[0].parseError, 'parseError als Spur erwartet');
});

test('toolCallsToCanonical: fehlende ID bekommt eine 9-stellige Ersatz-ID (Mistral-Vorgabe)', () => {
  const { toolUses } = toolCallsToCanonical('', [{ name: 'list_figures', arguments: '' }]);
  assert.equal(toolUses[0].id.length, 9);
  assert.match(toolUses[0].id, /^[A-Za-z0-9]+$/);
});

test('Ersatz-IDs: eindeutig über Position und Runde, immer 9 alphanumerische Zeichen', () => {
  const calls = Array.from({ length: 12 }, () => ({ name: 'list_figures', arguments: '' }));
  const r0 = toolCallsToCanonical('', calls).toolUses.map(t => t.id);
  const r1 = toolCallsToCanonical('', calls, { round: 1 }).toolUses.map(t => t.id);
  const all = [...r0, ...r1];
  assert.equal(new Set(all).size, all.length, 'Aufruf 1 und 10 bzw. Runde 0 und 1 dürfen nicht kollidieren');
  for (const id of all) assert.match(id, /^[A-Za-z0-9]{9}$/);
  const salvaged = salvageTextToolCalls('[{"name":"a"},{"name":"a"}]', ['a'], { round: 3 });
  assert.equal(new Set(salvaged.toolUses.map(t => t.id)).size, 2);
  assert.ok(salvaged.toolUses.every(t => !r0.includes(t.id) && /^[A-Za-z0-9]{9}$/.test(t.id)));
});

test('messagesToOpenAI: Text neben tool_results folgt als eigene user-Nachricht NACH den tool-Nachrichten', () => {
  const out = messagesToOpenAI([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'x', input: {} }, { type: 'tool_use', id: 'a2', name: 'y', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a1', content: '{"error":"nein"}' },
      { type: 'tool_result', tool_use_id: 'a2', content: 'ok' },
      { type: 'text', text: 'Antworte jetzt.' },
    ] },
  ]);
  assert.deepEqual(out.map(m => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.equal(out[3].content, 'Antworte jetzt.');
  // Ohne Text keine leere Zusatznachricht.
  const plain = messagesToOpenAI([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'ok' }] }]);
  assert.deepEqual(plain.map(m => m.role), ['tool']);
});

test('salvageTextToolCalls: als Text geschriebener Aufruf wird gerettet', () => {
  const names = ['search_passages', 'final_answer'];
  const got = salvageTextToolCalls('[TOOL_CALLS] [{"name": "search_passages", "arguments": {"pattern": "Anna"}}]', names);
  assert.ok(got, 'Rettung erwartet');
  assert.deepEqual(got.toolUses, [{ id: got.toolUses[0].id, name: 'search_passages', input: { pattern: 'Anna' } }]);
  // Der Text IST der Aufruf — er darf nicht zusätzlich als Textblock mitreisen,
  // sonst steht das JSON-Fragment später in der Antwort.
  assert.equal(got.rawContentBlocks.some(b => b.type === 'text'), false);
});

test('salvageTextToolCalls: Code-Fence-Variante und `parameters` statt `arguments`', () => {
  const got = salvageTextToolCalls('```json\n{"name":"get_pages","parameters":{"page_ids":[7]}}\n```', ['get_pages']);
  assert.ok(got);
  assert.deepEqual(got.toolUses[0].input, { page_ids: [7] });
});

test('salvageTextToolCalls: echte Antworten bleiben Antworten', () => {
  // final_answer-Envelope: kein `name` → kein Aufruf.
  assert.equal(salvageTextToolCalls('{"antwort":"Anna ist 34."}', ['final_answer']), null);
  // Prosa.
  assert.equal(salvageTextToolCalls('Anna ist 34 Jahre alt.', ['final_answer']), null);
  // Unbekannter Werkzeugname → nicht raten.
  assert.equal(salvageTextToolCalls('{"name":"rm_rf","arguments":{}}', ['final_answer']), null);
  assert.equal(salvageTextToolCalls('', ['final_answer']), null);
});

test('Round-Trip: eine Tool-Runde übersteht Kanonisch → OpenAI → Kanonisch', () => {
  const { rawContentBlocks } = toolCallsToCanonical('', [
    { id: 'aaaaaaaaa', name: 'quote_passage', arguments: '{"page_id":5,"pattern":"Anna"}' },
  ]);
  const openai = messagesToOpenAI([{ role: 'assistant', content: rawContentBlocks }]);
  const back = toolCallsToCanonical('', openai[0].tool_calls.map(tc => ({
    id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
  })));
  assert.deepEqual(back.toolUses, [{ id: 'aaaaaaaaa', name: 'quote_passage', input: { page_id: 5, pattern: 'Anna' } }]);
});


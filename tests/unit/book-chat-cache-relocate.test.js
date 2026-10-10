'use strict';
// Buch-Chat: Cache-Breakpoints im Tool-Pfad (lib/ai/claude.js) und Neu-Verankerung
// von final_answer-Zitaten mit verzählter Position (book-chat-tools/citations.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('book-chat-cache-relocate');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const { _withMessageCacheBreakpoints } = require('../../lib/ai/claude');
const { _relocate } = require('../../routes/jobs/book-chat-tools/citations');

const hasCc = (m) => Array.isArray(m.content) && m.content.some(b => b.cache_control);

test('Breakpoints: letzte Nachricht + markiertes Historien-Ende, Markierung nie im Request', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', cacheBreakpoint: true },
    { role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'frage' }] },
  ];
  const out = _withMessageCacheBreakpoints(msgs, 3);
  assert.equal(out.some(m => 'cacheBreakpoint' in m), false);
  assert.equal(hasCc(out[0]), false);
  assert.equal(hasCc(out[1]), true);
  assert.equal(out[2].content[1].cache_control?.type, 'ephemeral');
  assert.equal(out[2].content[0].cache_control, undefined);
  // Original unangetastet (der Loop verwendet das Array weiter).
  assert.equal(msgs[1].cacheBreakpoint, true);
  assert.equal(typeof msgs[1].content, 'string');
});

test('Breakpoints: Budget erschöpft → nur die letzte Nachricht, Markierung trotzdem entfernt', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', cacheBreakpoint: true },
    { role: 'user', content: 'c' },
  ];
  const out = _withMessageCacheBreakpoints(msgs, 1);
  assert.equal(hasCc(out[1]), false);
  assert.equal('cacheBreakpoint' in out[1], false);
  assert.equal(hasCc(out[2]), true);
});

test('Zitat neu verankern: exakt an verzählter Position, nächste Fundstelle gewinnt', () => {
  const text = 'Anna kam spät. Später sagte Anna: Ich bleibe hier. Und Anna: Ich bleibe hier.';
  const q = 'Ich bleibe hier.';
  const first = text.indexOf(q);
  const second = text.lastIndexOf(q);
  assert.deepEqual(_relocate(text, q, second - 3), { offset: second, length: q.length, match: 'exact' });
  assert.deepEqual(_relocate(text, q, 0), { offset: first, length: q.length, match: 'exact' });
});

test('Zitat neu verankern: tolerant bei Anführungs-/Strichvarianten, sonst null', () => {
  const text = 'Er sagte: «Das geht nicht – nie.» Dann ging er.';
  assert.deepEqual(_relocate(text, 'Das geht nicht - nie.', 5), { match: 'tolerant' });
  assert.equal(_relocate(text, 'Das steht nirgends im Text.', 5), null);
  // Zu kurz, um als Beleg zu taugen: keine Neu-Verankerung.
  assert.equal(_relocate(text, 'Er', 5), null);
});

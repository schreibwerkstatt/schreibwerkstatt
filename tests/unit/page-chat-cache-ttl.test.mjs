// Abschnitts-Chat: Abschnittsblock und Verlauf gehen mit 1h-TTL in den Prompt-Cache.
// Zwischen zwei Fragen liegen oft mehr als fünf Minuten; mit 5-min-TTL wurde der
// Abschnittsblock samt Verlauf fast jede Runde neu geschrieben statt gelesen.
// Die TTLs dürfen von vorne nach hinten nicht steigen (die API lehnt 1h hinter 5 min ab),
// darum tragen beide System-Blöcke 1h, wenn die Message-Breakpoints 1h tragen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cfg = JSON.parse(readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
const facade = await import('../../public/js/prompts.js');
facade.configurePrompts(cfg, 'claude');
const { buildChatSystemPrompt } = await import('../../public/js/prompts/chat.js');
const { _withMessageCacheBreakpoints } = require('../../lib/ai/claude.js');

const ccOf = (m) => (Array.isArray(m.content) ? m.content.at(-1).cache_control : undefined);

test('System des Abschnitts-Chats: beide Blöcke 1h', () => {
  const blocks = buildChatSystemPrompt('Seite', 'Text.', [], null);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => b.ttl), ['1h', '1h']);
});

test("Message-Breakpoints: '1h' setzt die 1h-TTL auf Verlaufsende und letzte Nachricht", () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', cacheBreakpoint: true },
    { role: 'user', content: 'c' },
  ];
  const out = _withMessageCacheBreakpoints(msgs, 2, '1h');
  assert.deepEqual(ccOf(out[1]), { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(ccOf(out[2]), { type: 'ephemeral', ttl: '1h' });
  assert.equal(ccOf(out[0]), undefined);
  assert.ok(out.every(m => !('cacheBreakpoint' in m)));
});

test('Message-Breakpoints ohne TTL bleiben bei 5 min (Werkzeug-Loop der agentischen Chats)', () => {
  const out = _withMessageCacheBreakpoints([{ role: 'user', content: 'a' }], 1);
  assert.deepEqual(ccOf(out[0]), { type: 'ephemeral' });
});

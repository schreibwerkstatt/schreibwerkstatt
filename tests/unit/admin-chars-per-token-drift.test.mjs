// Drift-Gate: die Budget-Vorschau der Admin-Einstellungen
// (public/js/admin/chars-per-token.js) rechnet mit derselben Zeichen/Token-Rate
// wie der Server (lib/ai/config.js#_claudeCharsPerToken / getContextConfigFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { charsPerTokenFor } from '../../public/js/admin/chars-per-token.js';

const require = createRequire(import.meta.url);
const ai = require('../../lib/ai');
const server = require('../../lib/ai/chars-per-token.js');

const MODELS = [
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-opus-4-1',
  'claude-3-5-haiku', '',
];

test('Claude-Rate je Modell = Server', () => {
  const serverBase = ai._claudeCharsPerToken('claude-3-5-haiku'); // klassisch = Basis
  for (const model of MODELS) {
    assert.equal(
      charsPerTokenFor('claude', { model, explicit: serverBase === 3 ? null : serverBase }),
      ai._claudeCharsPerToken(model),
      model,
    );
  }
});

test('Spiegel = Server-Regel für jeden Provider, Modell und expliziten Wert', () => {
  for (const explicit of [null, 1.8, 2.3, 3.5]) {
    for (const p of ['ollama', 'openai-compat']) {
      assert.equal(charsPerTokenFor(p, { explicit }), server.providerCharsPerToken(p, explicit), `${p} ${explicit}`);
    }
    for (const model of MODELS) {
      assert.equal(charsPerTokenFor('claude', { model, explicit }), server.claudeCharsPerToken(model, explicit), `${model} ${explicit}`);
    }
  }
});

test('Explizite Rate: gilt für alle Provider, Claude 5.x nimmt das Minimum', () => {
  assert.equal(charsPerTokenFor('ollama', { explicit: 3.5 }), 3.5);
  assert.equal(charsPerTokenFor('claude', { model: 'claude-sonnet-4-6', explicit: 3.5 }), 3.5);
  assert.equal(charsPerTokenFor('claude', { model: 'claude-opus-5-5', explicit: 3.5 }), 2.1);
  assert.equal(charsPerTokenFor('claude', { model: 'claude-opus-5-5', explicit: 1.8 }), 1.8);
  assert.equal(charsPerTokenFor('openai-compat'), 4);
});

test('Boot-Budget in Zeichen rechnet mit der Rate des globalen Claude-Modells', () => {
  const model = require('../../lib/app-settings').get('ai.claude.model') || 'claude-sonnet-5-5';
  assert.equal(ai.INPUT_BUDGET_CHARS, Math.floor(ai.INPUT_BUDGET_TOKENS * ai._claudeCharsPerToken(model)));
});

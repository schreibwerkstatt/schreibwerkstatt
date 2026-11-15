// Modell-Prädikate in lib/ai/config.js: welche Request-Felder ein Claude-Modell
// verträgt, wird ausschliesslich am Modellstring entschieden — ein Modellwechsel per
// App-Setting oder ALS-Override soll automatisch das richtige Verhalten wählen.
//
// Warum als Tabelle: die fünf Prädikate müssen für dieselbe Generation KONSISTENT
// antworten. Ein Modell, das `_isModernClaudeGen` verpasst, bekommt `temperature`
// mitgeschickt und stirbt an non-retryable HTTP 400 — genau der Fall, der beim
// Erscheinen von Opus 5 auftrat (die alte Regex traf nur `claude-opus-4-…`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

// Wie _bootstrap, setzt aber `ai.provider` VOR dem Laden von lib/ai/config: die
// Provider-Defaults der Zeichen/Token-Rate werden beim Modul-Load eingefroren.
function _bootstrapWithProvider(provider) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pred-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  require_('../../lib/app-settings').set('ai.provider', provider);
  return {
    dir,
    cfg: require_('../../lib/ai/config'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pred-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// modern = Sampling-Parameter entfernt (temperature → 400), Thinking adaptiv,
//          neuer Tokenizer (2.5 chars/Token), Structured Outputs
// maxOut = hartes Output-Ceiling, gegen das _callClaudeAttempt klemmt
// effort = akzeptiert output_config.effort überhaupt
// max    = 'max' wird durchgelassen (kam mit Opus 4.6 UND Sonnet 4.6)
// xhigh  = 'xhigh' wird durchgelassen (kam erst mit Opus 4.7)
const TABLE = [
  // Modellstring             modern  maxOut  effort  max    xhigh
  ['claude-opus-5-5',         true,   128000, true,   true,  true],
  ['claude-opus-5',           true,   128000, true,   true,  true],
  ['claude-opus-5[1m]',       true,   128000, true,   true,  true],
  ['claude-sonnet-5',         true,   128000, true,   true,  true],
  ['claude-fable-5',          true,   128000, true,   true,  true],
  ['claude-opus-4-8',         true,   128000, true,   true,  true],
  ['claude-opus-4-8[1m]',     true,   128000, true,   true,  true],
  ['claude-opus-4-7',         true,   128000, true,   true,  true],
  ['claude-opus-4-6',         false,  128000, true,   true,  false],
  ['claude-opus-4-5',         false,  128000, true,   false, false],
  ['claude-sonnet-4-6',       false,  64000,  true,   true,  false],
  ['claude-sonnet-4-5',       false,  64000,  false,  false, false], // effort → 400
  ['claude-haiku-4-5',        false,  64000,  false,  false, false], // effort → 400
];

test('Modell-Prädikate: Generation, Output-Ceiling und Effort-Leiter konsistent', () => {
  const { cfg, teardown } = _bootstrap();
  try {
    for (const [model, modern, maxOut, acceptsEffort] of TABLE) {
      assert.equal(cfg._isModernClaudeGen(model), modern, `_isModernClaudeGen('${model}')`);
      assert.equal(cfg._claudeModelMaxOut(model), maxOut, `_claudeModelMaxOut('${model}')`);
      assert.equal(cfg._claudeAcceptsEffort(model), acceptsEffort, `_claudeAcceptsEffort('${model}')`);
      // Abgeleitete Prädikate müssen der Generation folgen, nicht eigenständig driften.
      assert.equal(cfg._claudeAcceptsTemperature(model), !modern, `_claudeAcceptsTemperature('${model}')`);
      assert.equal(cfg._claudeUsesAdaptiveThinking(model), modern, `_claudeUsesAdaptiveThinking('${model}')`);
      // Ein modernes Modell darf NIE temperature bekommen (das ist der 400-Killer)
      // und muss immer ein thinking-Feld tragen (sonst leakt Reasoning-Prosa ins JSON).
      assert.equal('temperature' in cfg._claudeSamplingParams(model), !modern, `sampling('${model}')`);
      assert.equal('thinking' in cfg._claudeThinkingParams(model), modern, `thinking('${model}')`);
    }
  } finally { teardown(); }
});

test('Effort-Clamping: xhigh/max nur wo unterstützt, sonst auf high', () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  try {
    const effortFor = (model, effort) => logCtx.runWithContext({ aiJob: { provider: 'claude', effort } },
      () => cfg._claudeOutputConfigParams(model).output_config?.effort ?? null);

    for (const [model, , , acceptsEffort, allowsMax, allowsXhigh] of TABLE) {
      if (!acceptsEffort) {
        // Kein Effort-Feld senden — Sonnet 4.5 / Haiku 4.5 antworten sonst mit 400.
        assert.equal(effortFor(model, 'high'), null, `${model} darf kein effort senden`);
        assert.equal(effortFor(model, 'max'), null, `${model} darf kein effort senden`);
        continue;
      }
      // low/medium/high gibt es auf jedem Modell, das effort überhaupt kennt.
      assert.equal(effortFor(model, 'low'), 'low', `${model} low`);
      assert.equal(effortFor(model, 'medium'), 'medium', `${model} medium`);
      assert.equal(effortFor(model, 'high'), 'high', `${model} high`);
      assert.equal(effortFor(model, 'max'), allowsMax ? 'max' : 'high', `${model} max`);
      assert.equal(effortFor(model, 'xhigh'), allowsXhigh ? 'xhigh' : 'high', `${model} xhigh`);
    }
    // Ungültige Werte werden still verworfen (kein 400 durch Tippfehler im Setting).
    assert.equal(effortFor('claude-opus-5', 'ultra'), null);
    assert.equal(effortFor('claude-opus-5', ''), null);
  } finally { teardown(); }
});

test('Tokenizer-Rate: moderne Generation konservativer als der globale Default', () => {
  const { cfg, teardown } = _bootstrap();
  try {
    // Der neue Tokenizer produziert mehr Tokens → weniger Zeichen pro Token. Ein zu
    // optimistischer Wert überschätzt die Single-Pass-/Chunk-Zeichenbudgets.
    assert.ok(cfg._claudeCharsPerToken('claude-opus-5') <= 2.5);
    assert.ok(cfg._claudeCharsPerToken('claude-sonnet-5') <= 2.5);
    assert.ok(cfg._claudeCharsPerToken('claude-opus-5') < cfg._claudeCharsPerToken('claude-sonnet-4-6'));
  } finally { teardown(); }
});

// Mischbetrieb: `ai.provider` ist global, die KI-Profile haengen pro User daran vorbei.
// Die Zeichen/Token-Rate muss deshalb am GEFRAGTEN Provider haengen, nicht am global
// eingestellten — sonst rechnet ein Claude-Call mit der Rate eines lokalen Tokenizers
// (~4 statt ~3 Zeichen/Token), das Zeichenbudget faellt ein Drittel zu gross aus und der
// Prompt kippt mitten im Job ins Kontext-Overflow.
test('Tokenizer-Rate haengt am gefragten Provider, nicht am global eingestellten', () => {
  const { cfg, teardown } = _bootstrapWithProvider('ollama');
  try {
    assert.equal(cfg.CHARS_PER_TOKEN, 4, 'globale Anzeige-Rate folgt dem globalen Provider');
    assert.equal(cfg._claudeCharsPerToken('claude-sonnet-4-6'), 3,
      'Claude behaelt seine eigene Rate, auch wenn global ein lokaler Provider eingestellt ist');
    assert.equal(cfg.getContextConfigFor('ollama').charsPerToken, 4);
    assert.equal(cfg.getContextConfigFor('claude').charsPerToken <= 3, true);
  } finally { teardown(); }
});

// Kontextfenster + Output-Cap werden ohne Setting aus dem EFFEKTIVEN Modell abgeleitet
// (Job-Override vor global). Ein explizites Setting > 0 gewinnt weiterhin.
test('Kontextfenster/Output-Cap: aus dem Modell abgeleitet, Setting > 0 gewinnt', () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  const appSettings = require_('../../lib/app-settings');
  try {
    assert.equal(cfg._claudeModelContext('claude-opus-5-5'), 1000000);
    assert.equal(cfg._claudeModelContext('claude-sonnet-5'), 1000000);
    assert.equal(cfg._claudeModelContext('claude-sonnet-4-6'), 200000);
    assert.equal(cfg._claudeModelContext('claude-haiku-4-5'), 200000);

    appSettings.set('ai.claude.model', 'claude-opus-5-5');
    assert.equal(cfg._resolveClaudeContextWindow(), 1000000);
    assert.equal(cfg._resolveClaudeMaxOut(), 128000);

    // Per-Job-Modell (z.B. Lektorat) bestimmt die Ableitung, nicht das globale.
    appSettings.set('ai.claude.model', 'claude-sonnet-4-6');
    assert.equal(cfg._resolveClaudeContextWindow(), 200000);
    assert.equal(cfg._resolveClaudeMaxOut(), 64000);
    logCtx.runWithContext({ job: 'check' }, () => {
      logCtx.setContext({ aiJob: { provider: 'claude', model: 'claude-opus-5-5' } });
      assert.equal(cfg._resolveClaudeContextWindow(), 1000000);
      assert.equal(cfg._resolveClaudeMaxOut(), 128000);
    });

    appSettings.set('ai.claude.context_window', 300000);
    appSettings.set('ai.claude.max_tokens_out', 32000);
    assert.equal(cfg._resolveClaudeContextWindow(), 300000);
    assert.equal(cfg._resolveClaudeMaxOut(), 32000);
  } finally { teardown(); }
});

// Web-Suche mit dynamischer Filterung (Opus 4.6+, Sonnet 4.6+, Fable/Mythos — nicht
// Haiku) und tool_removal (Opus 4.8+, Fable/Mythos, Sonnet/Haiku 5.5+ — NICHT Sonnet 5).
// Ein Modell ausserhalb der Liste bekäme sonst einen 400 statt der alten Variante.
test('Modell-Prädikate: dynamische Web-Suche und tool_removal', () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  try {
    const rows = [
      // model                       dynSearch  removal
      ['claude-sonnet-4-5',          false,     false],
      ['claude-sonnet-4-6',          true,      false],
      ['claude-opus-4-6',            true,      false],
      ['claude-opus-4-7',            true,      false],
      ['claude-opus-4-8',            true,      true],
      ['claude-opus-5',              true,      true],
      ['claude-opus-5-5',            true,      true],
      ['claude-sonnet-5',            true,      false],
      ['claude-sonnet-5-5',          true,      true],
      ['claude-haiku-4-5',           false,     false],
      ['claude-haiku-5-5',           false,     true],
      ['claude-fable-5-2',           true,      true],
      ['claude-mythos-5-1',          true,      true],
    ];
    for (const [m, dyn, rem] of rows) {
      assert.equal(cfg._claudeSupportsDynamicWebSearch(m), dyn, `${m} dynSearch`);
      assert.equal(cfg._claudeSupportsToolRemoval(m), rem, `${m} removal`);
    }
    // Fähigkeitsfrage am effektiven Modell (Job-Bag), nur für Claude.
    logCtx.runWithContext({ job: 'check' }, () => {
      logCtx.setContext({ aiJob: { provider: 'claude', model: 'claude-opus-5-5' } });
      assert.equal(cfg.providerSupportsToolRemoval('claude'), true);
      assert.equal(cfg.providerSupportsToolRemoval('openai-compat'), false);
      logCtx.setContext({ aiJob: { provider: 'claude', model: 'claude-sonnet-5' } });
      assert.equal(cfg.providerSupportsToolRemoval('claude'), false);
    });
  } finally { teardown(); }
});

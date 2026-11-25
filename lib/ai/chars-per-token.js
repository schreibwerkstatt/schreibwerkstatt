'use strict';
// Zeichen/Token-Rate je Provider und Claude-Modell — pur, ohne Abhängigkeiten.
//
// Eigenes Modul, weil zwei Orte dieselbe Regel brauchen, die einander nicht laden
// dürfen: ./config.js (Budgets, Anzeige-Rate) und die Daten-Migration, die
// `page_stats.tok` neu rechnet (db/migrations/0374-tok-model-rate.js). Migrationen
// laufen beim Laden von lib/app-settings — ein require von lib/ai dort fände
// app-settings halb geladen vor.
// Browser-Spiegel für die Admin-Vorschau: public/js/admin/chars-per-token.js,
// gegated durch tests/unit/admin-chars-per-token-drift.test.mjs.
//
// Defaults: Claude-Klassik 3, lokale Tokenizer (Mistral/Llama/Qwen) 4. Der
// Opus-4.7+/Sonnet-5/Fable-Tokenizer zerlegt deutschen Fliesstext feiner (2.5),
// die 5er-Generation noch feiner: gemessen auf Prod (Erzählprofil Opus 5.5, ganzes
// Buch im Prompt) 1 054 748 Zeichen → 504 991 Input-Tokens = 2.09; count_tokens auf
// drei lokalen Büchern 2.04–2.11 (`npm run calibrate:tokens`). Ein explizit gesetztes
// `ai.chars_per_token` gilt für alle Provider; moderne Claude-Modelle nehmen davon das
// Minimum, damit ein hoher Admin-Wert ihr Budget nicht überschätzt.

const PROVIDER_DEFAULTS = { claude: 3, ollama: 4, 'openai-compat': 4 };
const MODERN_CLAUDE_CHARS_PER_TOKEN = 2.5;
const GEN5_CLAUDE_CHARS_PER_TOKEN = 2.1;

// Opus 4.7+, Sonnet 5+, Haiku 5+, Fable/Mythos 5+ (auch Suffix-Varianten wie «[1m]»).
function isModernClaudeGen(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[789]|\d\d)/.test(m)
    || /claude-opus-(?:[5-9]|\d\d)/.test(m)
    || /claude-sonnet-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-haiku-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m);
}

function isGen5Claude(model) {
  return /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|\d\d)/.test(String(model || ''));
}

/** Rate eines Providers ohne Modellbezug (Admin-Wert vor Default). */
function providerCharsPerToken(provider, explicit = null) {
  const ex = Number(explicit);
  return (Number.isFinite(ex) && ex > 0) ? ex : (PROVIDER_DEFAULTS[provider] || 4);
}

/** Rate eines Claude-Modells. */
function claudeCharsPerToken(model, explicit = null) {
  const base = providerCharsPerToken('claude', explicit);
  if (!isModernClaudeGen(model)) return base;
  return Math.min(base, isGen5Claude(model) ? GEN5_CLAUDE_CHARS_PER_TOKEN : MODERN_CLAUDE_CHARS_PER_TOKEN);
}

/** Anzeige-/Boot-Rate einer Instanz: Claude nach seinem Modell, sonst der Provider. */
function instanceCharsPerToken(provider, claudeModel, explicit = null) {
  return provider === 'claude' ? claudeCharsPerToken(claudeModel, explicit) : providerCharsPerToken(provider, explicit);
}

module.exports = {
  PROVIDER_DEFAULTS, MODERN_CLAUDE_CHARS_PER_TOKEN, GEN5_CLAUDE_CHARS_PER_TOKEN,
  isModernClaudeGen, isGen5Claude, providerCharsPerToken, claudeCharsPerToken, instanceCharsPerToken,
};

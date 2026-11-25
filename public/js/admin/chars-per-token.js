// Zeichen/Token-Rate je Provider für die Budget-Vorschau der Admin-Einstellungen.
// Spiegel von lib/ai/chars-per-token.js (Regel + Messwerte stehen dort): das
// Server-Modul ist CommonJS und läuft nicht im Browser. Gegen Drift gegated:
// tests/unit/admin-chars-per-token-drift.test.mjs (vergleicht beide für eine
// Modellliste und mit/ohne explizitem `ai.chars_per_token`).

const DEFAULTS = { claude: 3, ollama: 4, 'openai-compat': 4 };
const MODERN_CLAUDE = 2.5;
const GEN5_CLAUDE = 2.1;

function isModernClaudeGen(m) {
  return /claude-opus-4-(?:[789]|\d\d)/.test(m)
    || /claude-opus-(?:[5-9]|\d\d)/.test(m)
    || /claude-sonnet-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-haiku-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m);
}

function isGen5Claude(m) {
  return /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|\d\d)/.test(m);
}

/**
 * @param {string} provider  'claude' | 'ollama' | 'openai-compat'
 * @param {{ model?: string, explicit?: number|null }} opts  explicit = `ai.chars_per_token`
 */
export function charsPerTokenFor(provider, { model = '', explicit = null } = {}) {
  const ex = Number(explicit);
  const base = (Number.isFinite(ex) && ex > 0) ? ex : (DEFAULTS[provider] || 4);
  if (provider !== 'claude') return base;
  const m = String(model || '');
  if (!isModernClaudeGen(m)) return base;
  return Math.min(base, isGen5Claude(m) ? GEN5_CLAUDE : MODERN_CLAUDE);
}

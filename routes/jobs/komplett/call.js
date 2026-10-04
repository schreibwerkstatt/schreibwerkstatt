'use strict';
// KI-Call-Wrapper der Komplettanalyse (Kern-Pipeline, Standalone-Kontinuität,
// Standalone-Erzählprofil): bindet den effektiven Provider. Die Cache-Regel für den
// geteilten 1h-Buch-Präfix (kein Structured-Output-Schema) setzt der Claude-Provider
// selbst durch (lib/ai/claude.js#_isSharedPrefixSystem) — andere Provider brauchen das
// Schema als Grammar.
const { aiCall } = require('../shared');

/** Signatur wie aiCall ohne Provider-Slot: (jobId, tok, prompt, system, fromPct, toPct,
 *  expectedChars, outputRatio, maxTokens, schema, tier). */
function makeKomplettCall(provider) {
  return (jobId, tok, prompt, system, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema, tier) =>
    aiCall(jobId, tok, prompt, system, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema, tier);
}

/**
 * System-Blöcke auf EINE TTL setzen. Standalone-Jobs (Kontinuität, Erzählprofil) lesen
 * den Buchblock nur einmal: dort ist der 5-min-Write (1.25×) billiger als 1h (2×).
 * Alle Blöcke bekommen dieselbe TTL, weil die API eine längere TTL HINTER einer
 * kürzeren ablehnt (die `_BLOCKS`-Prompts tragen selbst einen 1h-Block).
 * `ttl` '1h' lässt die Blöcke unverändert, alles andere setzt den 5-min-Default.
 */
function withTtl(blocks, ttl) {
  if (ttl === '1h') return blocks || [];
  return (blocks || []).map(({ ttl: _drop, ...rest }) => rest);
}

module.exports = { makeKomplettCall, withTtl };

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

module.exports = { makeKomplettCall };

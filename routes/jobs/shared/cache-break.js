'use strict';
// Bruch-Melder für den geteilten 1h-Präfix (Claude-Prompt-Cache).
//
// Calls mit `{ sharedPrefix: true, ttl: '1h' }` als vorderstem System-Block (Buch- bzw.
// Kapiteltext der Komplettanalyse) zahlen den Write einmal und lesen danach für ~0.05×.
// Bricht der Präfix (andere Bytes, Schema, Modell/Effort, abgelaufene 1h), schreibt jeder
// Folge-Call den ganzen Block neu (doppelter Input-Preis), und der Lauf wird nur still
// teurer. Darum: hat in DIESEM Job schon ein Call denselben Block gesendet und schreibt der
// nächste trotzdem mehr, als er liest, wird gewarnt. Ein Erst-Write (A1, Multi-Pass-Basis,
// P3b im Multi-Pass) ist keiner, Standalone-Jobs mit eigenem `tok` ebenfalls nicht.

const crypto = require('crypto');

// Unter dieser Schwelle ist ein Write nur ein Phasen-System-Block, nie der Buch-/Kapiteltext.
const MIN_BREAK_TOKENS = 10000;

function _sharedPrefixKey(system) {
  const first = Array.isArray(system) ? system[0] : null;
  if (!first || !first.sharedPrefix || first.ttl !== '1h' || typeof first.text !== 'string') return null;
  return crypto.createHash('sha1').update(first.text).digest('hex');
}

/**
 * Prüft einen fertigen Call und merkt sich seinen geteilten Block. Gibt `true` zurück,
 * wenn der Call einen Bruch zeigt (der Aufrufer loggt). Wirft nie.
 * @param {object} tok  Job-Zähler; trägt `sharedPrefixSeen` (Set der Block-Hashes).
 * @param {*} system    System-Prompt des Calls (String oder Block-Array).
 * @param {{ cacheReadIn?: number, cacheCreationIn?: number }} usage
 */
function checkSharedPrefixCache(tok, system, usage) {
  try {
    if (!tok) return false;
    const key = _sharedPrefixKey(system);
    if (!key) return false;
    const seen = tok.sharedPrefixSeen || (tok.sharedPrefixSeen = new Set());
    const read = usage?.cacheReadIn || 0;
    const written = usage?.cacheCreationIn || 0;
    const broken = seen.has(key) && written >= MIN_BREAK_TOKENS && written > read;
    seen.add(key);
    return broken;
  } catch {
    return false;
  }
}

module.exports = { checkSharedPrefixCache, MIN_BREAK_TOKENS };

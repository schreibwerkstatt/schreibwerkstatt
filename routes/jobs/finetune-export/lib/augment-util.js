'use strict';

// Gemeinsame Werkzeuge der KI-Phasen des Finetune-Exports (samples/ai-augment.js,
// samples/reader/ai.js): Cache-Signatur, Bereinigung generierter Fragen und ein
// kleiner Pool, damit grosse Bücher den Provider nicht überrennen.

const crypto = require('crypto');

const AUGMENT_CONCURRENCY = 4;
// Haiku hat Rate-Limits und Preis für mehr parallele Calls; die schweren Modelle
// bleiben beim kleinen Pool. `model` ist das effektiv laufende (`ctx.aiModel`).
const AUGMENT_CONCURRENCY_HAIKU = 12;

function augmentConcurrency(model) {
  return /claude-haiku/.test(String(model || '')) ? AUGMENT_CONCURRENCY_HAIKU : AUGMENT_CONCURRENCY;
}

// Output-Deckel eines Augment-Calls aus der erwarteten Antwortlänge. Haiku 5+ denkt
// adaptiv, und das Denken zählt gegen dasselbe `max_tokens` wie das JSON — ein fester
// Deckel von 1500 truncierte lange Texte (Entwicklungsbogen einer Hauptfigur, Orte).
// Bezahlt wird nur, was erzeugt wird; der Deckel fängt nur Ausreisser ab.
const AUGMENT_THINK_RESERVE = 3000;
const AUGMENT_MAX_TOKENS_CAP = 16000;

function augmentMaxTokens(expectedChars) {
  return Math.min(AUGMENT_MAX_TOKENS_CAP, AUGMENT_THINK_RESERVE + Math.ceil(Math.max(0, expectedChars || 0) / 2.5));
}

function sha1(s) {
  return crypto.createHash('sha1').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

function trimInstr(s) {
  return String(s || '').trim().replace(/^["“”„«»‹›']+|["“”„«»‹›']+$/g, '').trim();
}

async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { AUGMENT_CONCURRENCY, AUGMENT_CONCURRENCY_HAIKU, augmentConcurrency, augmentMaxTokens, sha1, trimInstr, pmap };

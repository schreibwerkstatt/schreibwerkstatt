'use strict';

// Gemeinsame Werkzeuge der KI-Phasen des Finetune-Exports (samples/ai-augment.js,
// samples/reader/ai.js): Cache-Signatur, Bereinigung generierter Fragen und ein
// kleiner Pool, damit grosse Bücher den Provider nicht überrennen.

const crypto = require('crypto');

const AUGMENT_CONCURRENCY = 4;

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

module.exports = { AUGMENT_CONCURRENCY, sha1, trimInstr, pmap };

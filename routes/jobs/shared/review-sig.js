'use strict';
// Cache-Signaturen der KI-Jobs. `buildChapterPagesSig` gehört den Bewertungs-
// Jobs (Buchbewertung `review.js`, Kapitelbewertung `kapitel.js`): beide schreiben
// ihre Kapitelanalysen in denselben `chapter_review_cache` — eine Analyse mit
// gleicher Signatur ist zwischen den Jobs austauschbar, also muss die Signatur an
// EINER Stelle entstehen. `sigHash`/`systemChars` nutzen auch Lektorat und Exposé.
const crypto = require('crypto');
const { pageSigSuffix } = require('./chunking');

// Stabile, kurze Signatur für strukturierte Prompt-Vars (narrative,
// reviewSchwerpunkt, komplettContext). Identischer Inhalt → identische Sig.
function sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// pages_sig pro Chunk (analog Komplettanalyse): page_id:updated_at sortiert,
// plus alle Prompt-Vars, die das Kapitelanalyse-Ergebnis beeinflussen. `teil`
// steht drin, weil der Prompt eines Teil-Abschnitts anders lautet als der eines
// ganzen Kapitels.
function buildChapterPagesSig(chunk, { bookName, teil, narrativeSig, systemSig, cacheVersion }) {
  const pages = chunk.pages.map(p => `${p.id}:${p.updated_at || ''}${pageSigSuffix(p)}`).sort().join('|');
  const teilSig = teil ? `${teil.nr}/${teil.von}` : '';
  return `${pages}||${chunk.name}||${bookName}||${teilSig}||${narrativeSig}||${systemSig}||${cacheVersion}`;
}

// Zeichenlänge eines System-Prompts (String oder Cache-Block-Array).
function systemChars(system) {
  if (Array.isArray(system)) return system.reduce((s, b) => s + (b?.text?.length || 0), 0);
  return String(system || '').length;
}

module.exports = { sigHash, buildChapterPagesSig, systemChars };

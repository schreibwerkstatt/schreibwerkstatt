'use strict';

// Mehrzügige Gespräche für das Leser-Modell. Ein Website-Chat hat mehrere
// Runden; ein Modell, das nur Einzelfragen gesehen hat, verliert nach zwei,
// drei Runden den Faden. Gebaut wird aus bereits erzeugten Einzel-Samples,
// zusätzlich zu ihnen: Figuren-Gespräche — Ich-Form-Paare einer Figur,
// Einstieg mit der Bitte um die Figur, optional Rückkehr zum Buch.
//
// Keine Buch-Gespräche aus aneinandergereihten Faktenfragen: drei Fragen mit
// wörtlichem Ereignistitel («Wann erlebt Samuel «…»?» → «In welchem Kapitel
// erlebt Samuel «…»?») sind ein Quiz, kein Gespräch — die Folgefrage bezieht
// sich nicht auf die vorige Antwort. Die Rückkehr zum Buch nimmt nur eine
// Frage ohne Titel in Anführungszeichen.

const { hashSplit } = require('../../lib/names');
const { entryQuestion, EXIT, fill } = require('./persona');

const TURNS = 3;
const CONVS_PER_KEY = 2;

// Autor-Chat-IDs: `authorChat|fig…|<fig_id>|…` (author-chat/figures.js).
function convKeyOf(s) {
  if (s.convKey) return s.convKey;
  if (s.type !== 'authorChat') return null;
  const [, kind, figId] = String(s.id).split('|');
  return kind && kind.startsWith('fig') && figId ? 'fig:' + figId : null;
}

function pickOrder(items, key, seed) {
  return items
    .map((it, i) => ({ it, r: hashSplit(`${key}|${i}`, seed) }))
    .sort((a, b) => a.r - b.r)
    .map(x => x.it);
}

function buildPersonaConversations(ctx, push) {
  const lang = ctx.langIsEn ? 'en' : 'de';
  const seed = ctx.opts.valSeed;
  // Erste Buch-Antwort je Figur für den Rückweg «zurück zum Buch».
  const bookAnswer = new Map();
  for (const s of ctx.samples) {
    if (s.messages.length !== 3 || s.sourceKey) continue;
    const key = convKeyOf(s);
    if (key && !bookAnswer.has(key) && !/«/.test(s.messages[1].content)) bookAnswer.set(key, s);
  }
  for (const [key, { name, pairs }] of ctx.personaPairs) {
    const pool = pickOrder(pairs, 'pconv|' + key, seed);
    for (let c = 0; c < CONVS_PER_KEY; c++) {
      const chosen = pool.slice(c * TURNS, (c + 1) * TURNS);
      if (chosen.length < TURNS) break;
      const turns = chosen.map(([q, a], i) => [i === 0 ? entryQuestion(lang, name, q, `${key}|conv${c}`, seed) : q, a]);
      const back = c === 0 && bookAnswer.get(key);
      if (back) turns.push([fill(EXIT[lang].q, { name, q: back.messages[1].content }), back.messages[2].content]);
      push({ id: `reader|personaConv|${key}|${c}`, turns });
    }
  }
}

function buildReaderConversations(ctx, push) {
  buildPersonaConversations(ctx, push);
}

module.exports = { buildReaderConversations, convKeyOf };

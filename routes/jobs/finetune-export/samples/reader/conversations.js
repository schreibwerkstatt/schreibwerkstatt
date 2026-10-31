'use strict';

// Mehrzügige Gespräche für das Leser-Modell. Ein Website-Chat hat mehrere
// Runden; ein Modell, das nur Einzelfragen gesehen hat, verliert nach zwei,
// drei Runden den Faden. Gebaut wird aus bereits erzeugten Einzel-Samples,
// zusätzlich zu ihnen:
//   - Buch-Gespräche: Fragen zum selben Thema (`convKey`, für Autor-Chat-Figuren
//     aus der Sample-ID abgeleitet) hintereinander;
//   - Figuren-Gespräche: Ich-Form-Paare einer Figur, Einstieg mit der Bitte um
//     die Figur, optional Rückkehr zum Buch.
// Antworten mit Buchtext (`sourceKey`) dürfen nur mit Turns desselben Kapitels
// oder ohne Buchtext zusammenkommen — sonst risse das Gespräch das Holdout auf.

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

function buildBookConversations(ctx, push) {
  const seed = ctx.opts.valSeed;
  // Nur tragende Figuren: der Katalog führt auch Neben- und Metaphern-Figuren
  // mit dünnen Antworten, die als Gespräch nur Rauschen wären.
  const central = new Set((ctx.readerFigures || []).map(r => r.key));
  const groups = new Map();
  for (const s of ctx.samples) {
    if (s.messages.length !== 3) continue;
    const key = convKeyOf(s);
    if (!key || !central.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const [key, list] of groups) {
    // Paraphrasen derselben Antwort sind kein Gespräch: je Antwort ein Turn.
    const byAnswer = new Map();
    for (const s of list) {
      const a = s.messages[2].content;
      if (!byAnswer.has(a)) byAnswer.set(a, s);
    }
    const pool = pickOrder([...byAnswer.values()], 'conv|' + key, seed);
    for (let c = 0; c < CONVS_PER_KEY; c++) {
      const chosen = [];
      let src;
      for (const s of pool.slice(c * TURNS)) {
        if (s.sourceKey && src && s.sourceKey !== src) continue;
        if (s.sourceKey) src = s.sourceKey;
        chosen.push(s);
        if (chosen.length === TURNS) break;
      }
      if (chosen.length < TURNS) break;
      push({
        id: `reader|conv|${key}|${c}`,
        turns: chosen.map(s => [s.messages[1].content, s.messages[2].content]),
        sourceKey: src,
      });
    }
  }
}

function buildPersonaConversations(ctx, push) {
  const lang = ctx.langIsEn ? 'en' : 'de';
  const seed = ctx.opts.valSeed;
  // Erste Buch-Antwort je Figur für den Rückweg «zurück zum Buch».
  const bookAnswer = new Map();
  for (const s of ctx.samples) {
    if (s.messages.length !== 3 || s.sourceKey) continue;
    const key = convKeyOf(s);
    if (key && !bookAnswer.has(key)) bookAnswer.set(key, s);
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
  buildBookConversations(ctx, push);
  buildPersonaConversations(ctx, push);
}

module.exports = { buildReaderConversations, convKeyOf };

'use strict';

const { clipAtSentenceStrict } = require('./text');

// Antwortlänge pro Aufgabentyp deckeln (`maxAnswerChars`, z.B.
// `{ sceneWrite: 2000, continue: 1500 }`). Lange Ziele dominieren den Loss und
// belohnen Auswendiglernen. Gekürzt wird nur an einer Satz- oder Absatzgrenze.
// Samples mit `noTruncate` («Teil N von M», Wörtlich-Slices) werden nicht
// gekürzt: ein gekapptes Teilstück wäre eine falsche Wiedergabe, sie fallen
// weg. Die Sampler schneiden ihre Teile deshalb gleich in Deckel-Grösse.
//
// `entries`: `{ s, tokens }` aus finalize.js; `retoken(sample)` rechnet die
// Sample-Tokens nach dem Kürzen neu. → `{ kept, clipped, dropped }`.
function capAnswerLengths(entries, maxAnswerChars, retoken) {
  const caps = maxAnswerChars || {};
  if (!Object.keys(caps).length) return { kept: entries, clipped: 0, dropped: 0 };
  const kept = [];
  let clipped = 0, dropped = 0;
  for (const e of entries) {
    const cap = Number(caps[e.s.task]) || 0;
    const last = e.s.messages[e.s.messages.length - 1];
    if (!cap || !last || last.role !== 'assistant' || last.content.length <= cap) { kept.push(e); continue; }
    if (e.s.noTruncate) { dropped++; continue; }
    const head = clipAtSentenceStrict(last.content, cap);
    if (head.length < Math.min(60, cap * 0.3)) { dropped++; continue; }
    last.content = head;
    e.tokens = retoken(e.s);
    clipped++;
    kept.push(e);
  }
  return { kept, clipped, dropped };
}

module.exports = { capAnswerLengths };

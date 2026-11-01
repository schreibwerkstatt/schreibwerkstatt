'use strict';

// Ich-Form der tragenden Figuren. Der Leser bittet im Gespräch um die Figur
// («Ich möchte mit X sprechen»), das Modell antwortet als X — ein einziger
// System-Prompt trägt Buch und Figuren (system.js).
//   - Stimm-Anker (hier, ohne KI): echte Dialogzeilen der Figur als Antwort.
//   - Fragen an die Figur mit Antwort in der Ich-Form: KI-Phase in ai.js.
// Vorlagen sind Trainingstext, keine UI-Strings.

const { hashSplit } = require('../../lib/names');
const { looksLikeNarration } = require('../../lib/text');
const { hasPersonaMaterial } = require('./figures');

const ENTRY = {
  de: ['Ich möchte mit {name} sprechen. {q}', '{name}, darf ich dich etwas fragen? {q}', 'Lass mich mit {name} reden. {q}', 'Frage an {name}: {q}'],
  en: ['I would like to talk to {name}. {q}', '{name}, may I ask you something? {q}', 'Let me speak with {name}. {q}', 'A question for {name}: {q}'],
};
const ANCHOR_Q = {
  de: ['Sag mir etwas, wie nur du es sagen würdest.', 'Wie klingst du, wenn du redest?', 'Erzähl mir etwas, in deinen eigenen Worten.'],
  en: ['Say something only you would say.', 'How do you sound when you talk?', 'Tell me something, in your own words.'],
};
const EXIT = {
  de: { q: 'Danke, {name}. Ich möchte jetzt wieder mit dem Buch sprechen. {q}' },
  en: { q: 'Thank you, {name}. I would like to talk to the book again now. {q}' },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function entryQuestion(lang, name, q, key, seed) {
  const pool = ENTRY[lang];
  return fill(pool[Math.floor(hashSplit('entry|' + key, seed) * pool.length)], { name, q });
}

// Jede Dialogzeile einmal als Antwort, in Gruppen zu höchstens drei Zeilen
// desselben Kapitels — die Antwort ist wörtlicher Buchtext (Split nach Abschnitt, lib/split.js).
function buildPersonaAnchorSamples(ctx, readerFigures, push) {
  const lang = ctx.langIsEn ? 'en' : 'de';
  const seed = ctx.opts.valSeed;
  for (const rf of readerFigures) {
    if (!hasPersonaMaterial(rf)) continue;
    const byChapter = new Map();
    for (const d of rf.dialogs) {
      if (looksLikeNarration(d.quote)) continue;
      if (!byChapter.has(d.chapterId)) byChapter.set(d.chapterId, []);
      byChapter.get(d.chapterId).push(d.quote);
    }
    for (const [chId, quotes] of byChapter) {
      for (let i = 0; i < quotes.length; i += 3) {
        const key = `${rf.key}|${chId}|${i}`;
        const q = ANCHOR_Q[lang][Math.floor(hashSplit('anchorQ|' + key, seed) * ANCHOR_Q[lang].length)];
        push({
          id: `reader|personaVoice|${key}`,
          turns: [[entryQuestion(lang, rf.name, q, key, seed), quotes.slice(i, i + 3).join(' ')]],
          sourceKey: 'ch:' + chId,
        });
      }
    }
  }
}

module.exports = { buildPersonaAnchorSamples, entryQuestion, EXIT, fill };

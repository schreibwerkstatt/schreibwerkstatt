'use strict';

const { hashSplit } = require('../../lib/names');

// Faktenkarten + Varianten. Eine Karte ist EIN Fakt mit stabiler ID
// (`rel:fig_3|fig_7`, `fig:fig_3:beruf`) — so lässt sie sich später einzeln als
// Dokument exportieren (Retrieval). Jede Karte erscheint in mehreren
// Varianten: verschiedene Fragen UND verschieden formulierte Antworten, denn
// ein kleines LoRA lernt einen Fakt erst über mehrere verschieden formulierte
// Begegnungen. Alle Varianten tragen `factId` und dieselbe `unit` — sie
// landen beim Split auf derselben Seite (lib/split.js); `core` hält Kernfakten
// immer im Train.

function makeCoreHelpers(ctx) {
  const { samples, counts, unifiedSys, opts } = ctx;
  const seed = opts.valSeed;
  ctx.factCards = ctx.factCards || [];
  const k = Math.max(1, Math.min(Number(opts.maxVariantsPerFact) || 5, Number(opts.factParaphrases) || 4));

  const order = (n, tag) => [...Array(n).keys()]
    .sort((a, b) => hashSplit(tag + '|' + a, seed) - hashSplit(tag + '|' + b, seed));

  // `card`: { id, kind, subject, fields, unit, core }.
  // `questions` / `answers`: Listen; `count` überschreibt die Variantenzahl.
  // `dir` (optional): Fragerichtung derselben Karte (Beziehung A→B / B→A),
  // steht am Sample und in seiner ID.
  const carded = new Set();
  function emitCard(card, { task, questions, answers, count, dir }) {
    const qs = [...new Set(questions.map(q => String(q || '').trim()).filter(q => q.length >= 4))];
    const as = [...new Set(answers.map(a => String(a || '').trim()).filter(a => a.length >= 12))];
    if (!qs.length || !as.length) return 0;
    const n = Math.min(count || k, qs.length * as.length);
    const tag = card.id + (dir ? '|' + dir : '');
    const qo = order(qs.length, tag + '|q');
    const ao = order(as.length, tag + '|a');
    const seen = new Set();
    let emitted = 0;
    for (let i = 0; emitted < n && i < n * 3; i++) {
      const q = qs[qo[i % qs.length]];
      const a = as[ao[(i + Math.floor(i / qs.length)) % as.length]];
      const key = q + '\u0000' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        id: `core|${tag}|${emitted}`,
        type: 'core',
        task,
        factId: card.id,
        ...(dir ? { dir } : {}),
        unit: card.unit || card.id,
        ...(card.core ? { core: true } : {}),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: q },
          { role: 'assistant', content: a },
        ],
      });
      emitted++;
    }
    counts.core = (counts.core || 0) + emitted;
    if (emitted && !carded.has(card.id)) {
      carded.add(card.id);
      ctx.factCards.push({ id: card.id, kind: card.kind, subject: card.subject, statement: as[0], fields: card.fields || {} });
    }
    return emitted;
  }

  return { emitCard, variantCount: k };
}

module.exports = { makeCoreHelpers };

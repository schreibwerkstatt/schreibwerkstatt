'use strict';

const { makeCoreHelpers } = require('./variants');
const { buildRelationCore } = require('./relations');
const { buildFigureCore, countMentions } = require('./figures');
const { buildEventCore, buildChapterCore } = require('./events');

// Kernwissen (docs/finetuning.md#kernwissen): Grundfakten als eigene,
// paraphrasierte Aufgaben — «Wer ist X?», Beziehungen in beiden Richtungen,
// Einzelattribute, Ereignis-Facetten, Kapitelinhalt. Jede Karte in mehreren
// Varianten (`factParaphrases`), Kernfakten der Figuren ab `minMentions`
// Erwähnungen bleiben immer im Train (`core`).
//
// Legt in ctx ab: `figMentions`, `eligibleFigIds`, `relationFacts`,
// `relationConflicts`, `factCards` — Eval-Set, Falsche-Annahme-Fragen und
// Statistik lesen dort.
function buildCoreFactSamples(ctx) {
  ctx.figMentions = countMentions(ctx.figRows, ctx.pageContents);
  const min = Math.max(1, Number(ctx.opts.minMentions) || 5);
  ctx.eligibleFigIds = new Set(ctx.figRows.filter(f => (ctx.figMentions.get(f.fig_id) || 0) >= min).map(f => f.fig_id));
  const { emitCard, variantCount } = makeCoreHelpers(ctx);
  const rel = buildRelationCore(ctx, emitCard, variantCount);
  ctx.relationFacts = rel.facts;
  ctx.relationConflicts = rel.conflicts;
  buildFigureCore(ctx, emitCard, rel.facts);
  buildEventCore(ctx, emitCard);
  buildChapterCore(ctx, emitCard);
}

module.exports = { buildCoreFactSamples };

'use strict';

const { makeCoreHelpers } = require('./variants');
const { buildRelationCore } = require('./relations');
const { buildFigureCore, countMentions } = require('./figures');
const { buildEventCore, buildChapterCore } = require('./events');
const { buildCoreFactSet } = require('./core-set');
const { buildEventWhy } = require('./why');
const { buildTimelineReverse } = require('./timeline');
const { nameInfo } = require('./naming');
const { figureTier } = require('./words');

// Kernwissen (docs/finetuning.md#kernwissen): Grundfakten als eigene,
// paraphrasierte Aufgaben — «Wer ist X?», Beziehungen in beiden Richtungen,
// Einzelattribute, Ereignis-Facetten, Warum-Fragen (why.js), Zeitstrahl
// rückwärts (timeline.js), Kapitelinhalt. Jede Karte in mehreren
// Varianten (`factParaphrases`), Kernfakten der Figuren ab `minMentions`
// Erwähnungen bleiben immer im Train (`core`).
//
// Legt in ctx ab: `figMentions`, `eligibleFigIds`, `relationFacts`,
// `relationResidual`, `conflictDropped`, `factCards`, `figNameInfo` (naming.js), `tierByFig`
// (words.js#figureTier) — Eval-Set, Falsche-Annahme-Fragen, Mischung und
// Statistik lesen dort.
//
// Eine Figur, deren Nennform eine andere Figur teilt («Herr Koch» für drei
// Figuren), bekommt kein Kernwissen: «Wer ist Herr Koch?» hätte drei
// widersprüchliche Antworten.
// Namensinfo, Bedeutung und Erwähnungen der Figuren — braucht auch die
// Beziehungsprüfung (lib/relation-check.js), die vor allen Samplern läuft.
function prepareFigureInfo(ctx) {
  if (ctx.figNameInfo) return;
  ctx.figMentions = countMentions(ctx.figRows, ctx.pageContents);
  ctx.figNameInfo = nameInfo(ctx.figRows);
  ctx.tierByFig = new Map(ctx.figRows.map(f => [f.fig_id, figureTier(f.typ)]));
}

function buildCoreFactSamples(ctx) {
  prepareFigureInfo(ctx);
  const min = Math.max(1, Number(ctx.opts.minMentions) || 5);
  ctx.eligibleFigIds = new Set(ctx.figRows
    .filter(f => (ctx.figMentions.get(f.fig_id) || 0) >= min && !ctx.figNameInfo.get(f.fig_id).ambiguous)
    .map(f => f.fig_id));
  const { emitCard, variantCount } = makeCoreHelpers(ctx);
  const rel = buildRelationCore(ctx, emitCard, variantCount);
  ctx.relationFacts = rel.facts;
  ctx.relationResidual = rel.conflicts;
  ctx.conflictDropped = rel.conflictDropped;
  buildFigureCore(ctx, emitCard, rel.facts);
  buildEventCore(ctx, emitCard);
  buildEventWhy(ctx, emitCard);
  buildTimelineReverse(ctx, emitCard);
  buildChapterCore(ctx, emitCard);
  buildCoreFactSet(ctx);
}

module.exports = { buildCoreFactSamples, prepareFigureInfo };

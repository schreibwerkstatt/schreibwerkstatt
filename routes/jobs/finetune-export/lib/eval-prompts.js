'use strict';

const { valPageKeys } = require('./split');
const { clipAtSentence, splitParagraphs } = require('./text');
const { stylePrefix } = require('../samples/style');
const { buildQuestionPools } = require('../samples/author-chat');
const { buildReaderEvalPrompts } = require('../samples/reader/eval');

// Testprompts für den Vorher/Nachher-Vergleich (docs/finetuning.md §5):
// dieselben Fragen ans Basismodell und ans trainierte Modell. Gefüllt mit
// echten Figuren- und Kapitelnamen und im Wortlaut der Trainings-
// Instruktionen, damit ein Treffer messbar ist. Holdout-Prompts stammen aus
// Abschnitten, die der Split nach `val` gelegt hat (dieselbe Auswahl wie
// finalize.js, lib/split.js#valPageKeys) — sie prüfen Stil an Text, den das
// Modell nie gesehen hat.
//
// Zeile: { category, holdout, messages: [system, user] }.
function buildEvalPrompts(ctx) {
  const {
    langIsEn, unifiedSys, opts,
    figRows, figById, figRelRows, chapterKeys, chapterNameByKey, chapterFullTextByKey,
    pageContents = [],
  } = ctx;
  const { figQuestions, chapterQuestions } = buildQuestionPools(langIsEn);
  const valPages = valPageKeys(pageContents, opts);
  const out = [];
  const add = (category, user, holdout = false) => out.push({
    category, holdout,
    messages: [{ role: 'system', content: unifiedSys }, { role: 'user', content: user }],
  });

  const figs = figRows.filter(f => f.name && f.name.trim());
  for (const f of figs.slice(0, 3)) add('figure', figQuestions[0].replace('{name}', f.name));

  for (const rel of figRelRows.slice(0, 2)) {
    const a = figById.get(rel.from_fig_id)?.name;
    const b = figById.get(rel.to_fig_id)?.name;
    if (a && b) add('relation', langIsEn ? `How does ${a} relate to ${b}?` : `Wie steht ${a} zu ${b}?`);
  }

  const withText = chapterKeys.filter(k => (chapterFullTextByKey.get(k) || '').length >= 400);
  for (const k of withText.slice(0, 2)) {
    add('chapter', chapterQuestions[0].replace('{kapitel}', chapterNameByKey.get(k)));
  }

  // Fortsetzung: Anfang eines Abschnitts, bevorzugt aus dem Holdout.
  const isVal = (p) => valPages.has('p:' + p.id);
  const withPara = pageContents.filter(p => clipAtSentence(splitParagraphs(p.text || '')[0] || '', 800).length >= 120);
  const valP = withPara.filter(isVal);
  const contPages = valP.length ? valP.slice(0, 2) : withPara.slice(-1);
  for (const p of contPages) {
    const opening = clipAtSentence(splitParagraphs(p.text)[0], 800);
    add('continuation', stylePrefix(langIsEn) + opening, isVal(p));
  }

  if (figs.length >= 2) {
    const [a, b] = figs;
    add('newChapter', langIsEn
      ? `Write the beginning of a new chapter in which ${a.name} and ${b.name} meet.`
      : `Schreibe den Anfang eines neuen Kapitels, in dem ${a.name} und ${b.name} aufeinandertreffen.`);
  }

  buildReaderEvalPrompts(ctx, add);
  return out;
}

module.exports = { buildEvalPrompts };

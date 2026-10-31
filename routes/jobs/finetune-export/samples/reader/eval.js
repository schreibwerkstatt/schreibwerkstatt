'use strict';

// Testprompts des Leser-Modells für eval.jsonl (lib/eval-prompts.js): fragen
// ab, was nur die Leser-Samples lehren — Innenleben, Ich-Form, Warum-Fragen,
// Nichtwissen und Off-Topic. Wortlaut wie im Training, damit Treffer messbar sind.

const { KERN_TEXT } = require('./psyche');
const { entryQuestion } = require('./persona');
const { hasPersonaMaterial } = require('./figures');
const { unknownNames, FAKE_FIGURES, BOUNDARY_TEXT } = require('./boundaries');

function buildReaderEvalPrompts(ctx, add) {
  const { langIsEn, opts, readerFigures = [], sceneRows, figsByScene, figById, pageContents } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const fill = (tpl, name) => tpl.replace(/\{name\}/g, name);

  // «Was treibt X an?» — gelernt aus Werkstatt-Want oder Analyse-Motivation.
  for (const rf of readerFigures.filter(r => r.notes.want || r.fig?.motivation).slice(0, 2)) {
    add('psyche', fill(KERN_TEXT.want[lang].q[1], rf.name));
  }
  for (const rf of readerFigures.filter(hasPersonaMaterial).slice(0, 2)) {
    const q = langIsEn ? 'What are you most afraid of?' : 'Wovor hast du am meisten Angst?';
    add('persona', entryQuestion(lang, rf.name, q, rf.key + '|eval', opts.valSeed));
  }
  const scene = sceneRows.find(s => s.titel && (figsByScene.get(s.id) || []).length);
  const sceneFig = scene && figById.get(figsByScene.get(scene.id)[0])?.name;
  if (sceneFig) {
    add('why', langIsEn
      ? `Why does ${sceneFig} act the way they do in the scene «${scene.titel}»?`
      : `Warum verhält sich ${sceneFig} in der Szene «${scene.titel}» so?`);
  }
  const hay = pageContents.map(p => p.text || '').join('\n').toLowerCase();
  const fake = unknownNames(FAKE_FIGURES[lang], hay)[0];
  if (fake) add('unknown', BOUNDARY_TEXT[lang].figQ[0].replace('{fake}', fake));
  add('offTopic', BOUNDARY_TEXT[lang].offQ[0]);
}

module.exports = { buildReaderEvalPrompts };

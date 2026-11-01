'use strict';

// Testprompts des Leser-Modells für eval.jsonl (lib/eval-prompts.js):
// Innenleben, Ich-Form, Warum-Fragen, Nichtwissen, Off-Topic und falsche
// Annahmen. Eigene Formulierungen, die so nicht im Train stehen; Referenz
// (`expected`) und Prüfwörter (`mustContain`) wie in lib/eval-prompts.js.

const { entryQuestion } = require('./persona');
const { hasPersonaMaterial } = require('./figures');
const { REFUSAL_TEXT, buildHaystack, unknownNames, WRONG_TYP } = require('./refusals');
const { genderOf, roleNoun, rolePhrase } = require('../core-facts/words');

const EQ = {
  de: {
    psyche: ['Was bewegt {n} im Innersten?', 'Wonach sehnt sich {n} eigentlich?', 'Was belastet {n} am meisten?'],
    persona: ['Wovor hast du am meisten Angst?', 'Was bereust du?', 'Wem vertraust du?'],
    why: 'Was steckt dahinter, dass {f} in der Szene «{s}» so handelt?',
    unknown: ['Was kannst du mir über {x} erzählen?', 'Welche Rolle hat {x} bei dir?', 'Erinnerst du dich an {x}?'],
    fakes: ['Konstantin Zwyssig', 'Aurelia Pfändler', 'Gebhard Nüesch', 'Theodora Ammann-Lüthi', 'Cyprian Haldimann'],
    offTopic: [['Wie backe ich einen Zitronenkuchen?', 'ein Kuchenrezept'], ['Schreib mir eine E-Mail an meinen Chef.', 'eine E-Mail an deinen Chef'], ['Wie hoch ist der Mount Everest?', 'Geografie-Wissen']],
  },
  en: {
    psyche: ['What moves {n} deep inside?', 'What does {n} really long for?', 'What weighs on {n} the most?'],
    persona: ['What are you most afraid of?', 'What do you regret?', 'Whom do you trust?'],
    why: 'What lies behind the way {f} acts in the scene «{s}»?',
    unknown: ['What can you tell me about {x}?', 'What part does {x} play in you?', 'Do you remember {x}?'],
    fakes: ['Constantine Hartwell', 'Aurelia Pendergast', 'Gideon Marchbanks', 'Theodora Ashcombe-Lyle', 'Cyprian Holloway'],
    offTopic: [['How do I bake a lemon cake?', 'a cake recipe'], ['Write me an email to my boss.', 'an email to your boss'], ['How high is Mount Everest?', 'geography facts']],
  },
};

const STOP = new Set(['dieser', 'diese', 'dieses', 'seine', 'seiner', 'ihrer', 'einer', 'eines', 'werden', 'wurde', 'zwischen', 'durch', 'nicht', 'immer', 'wieder', 'their', 'there', 'which', 'about', 'would', 'because']);

// Prüfwörter aus einem Referenztext: die längsten Inhaltswörter (≥ 6 Zeichen),
// ohne den Namen, nach dem gefragt wird.
function keyTerms(text, n = 2, exclude = '') {
  const ex = new Set(String(exclude).toLowerCase().split(/\s+/));
  const words = [...new Set(String(text || '').split(/[^\p{L}-]+/u).filter(w => w.length >= 6 && !STOP.has(w.toLowerCase()) && !ex.has(w.toLowerCase())))];
  return words.sort((a, b) => b.length - a.length).slice(0, n);
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function buildReaderEvalPrompts(ctx, add, { PER_CAT = 3, rels = [] } = {}) {
  const { langIsEn, opts, readerFigures = [], sceneRows, figsByScene, figById, displayName: book } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const eq = EQ[lang];
  const rt = REFUSAL_TEXT[lang];

  const inner = (rf) => [rf.notes?.want, rf.notes?.need, rf.notes?.wound, rf.fig?.motivation, rf.fig?.konflikt].filter(Boolean).join(' ');
  readerFigures.filter(rf => inner(rf)).slice(0, PER_CAT).forEach((rf, i) => {
    const ref = inner(rf);
    add('psyche', fill(eq.psyche[i % 3], { n: rf.name }), { expected: ref, mustContain: keyTerms(ref, 2, rf.name) });
  });

  readerFigures.filter(hasPersonaMaterial).slice(0, PER_CAT).forEach((rf, i) => {
    const q = eq.persona[i % 3];
    add('persona', entryQuestion(lang, rf.name, q, rf.key + '|eval' + i, opts.valSeed), {
      expected: rf.dialogs?.[0]?.quote || inner(rf), mustContain: [langIsEn ? 'I' : 'ich'] });
  });

  const scenes = sceneRows.filter(s => s.titel && (figsByScene.get(s.id) || []).length).slice(0, PER_CAT);
  for (const s of scenes) {
    const f = figById.get(figsByScene.get(s.id)[0]);
    if (!f) continue;
    const ref = [f.motivation, f.konflikt].filter(Boolean).join(' ');
    add('why', fill(eq.why, { f: f.name, s: s.titel }), { expected: ref, mustContain: ref ? keyTerms(ref, 1, f.name) : [f.name] });
  }

  const hay = buildHaystack(ctx);
  unknownNames(eq.fakes, hay).slice(0, PER_CAT).forEach((x, i) => {
    add('unknown', fill(eq.unknown[i % 3], { x }), { expected: fill(rt.figA[0], { x, book }), mustContain: [langIsEn ? 'not' : 'nicht'] });
  });

  eq.offTopic.slice(0, PER_CAT).forEach(([q, thing], i) => {
    add('offTopic', q, {
      expected: fill(rt.offA[i % rt.offA.length], { thing, Thing: thing.charAt(0).toUpperCase() + thing.slice(1), book, hook: book }),
      mustContain: [langIsEn ? 'not' : 'nicht'] });
  });

  // Falsche Annahme: Rolle der Kernbeziehung vertauscht (Geschwister statt Eltern …).
  let n = 0;
  for (const r of rels) {
    if (n >= PER_CAT) break;
    const right = roleNoun(r.typ, genderOf(r.b), langIsEn);
    const wrong = WRONG_TYP[r.typ] && roleNoun(WRONG_TYP[r.typ], genderOf(r.b), langIsEn);
    if (!right || !wrong || right.noun === wrong.noun) continue;
    const vars = { y: r.b.name, wrong: rolePhrase(r.a.name, wrong, WRONG_TYP[r.typ], langIsEn), right: rolePhrase(r.a.name, right, r.typ, langIsEn) };
    add('falsePremise', fill(langIsEn ? 'Why exactly is {y} {wrong}?' : 'Warum genau ist {y} eigentlich {wrong}?', vars), {
      expected: fill(rt.fpRelA[0], vars), mustContain: [right.noun] });
    n++;
  }
}

module.exports = { buildReaderEvalPrompts, keyTerms };

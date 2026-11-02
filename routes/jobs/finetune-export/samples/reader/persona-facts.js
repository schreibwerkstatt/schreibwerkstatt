'use strict';

// Ich-Form der Hauptfiguren ohne KI (Typ `readerPersona`, docs/finetuning.md#leser-modell):
// der Leser bittet um die Figur und fragt sie nach ihren Beziehungen, Eckdaten
// und ihrem Innenleben; sie antwortet durchgehend in der 1. Person, aus den
// geprüften Kernfakten (Beziehungen ohne Konflikt-Paare, eigenes Geburtsjahr,
// Beruf, Hauptkapitel) und den Psyche-Facetten (core-facts/psyche.js), deren
// Sätze first-person.js sicher umformt — was sich nicht sicher umformen lässt,
// fällt weg. Ziel: mindestens 30 Fragen je Hauptfigur.
//
// Die Figur spricht den Leser nicht als Bekannten an («Du bist mein bester
// Freund»), und kein Satz fällt in die 3. Person (lib/answer-lint.js
// #personaThirdPerson prüft das für jede Ich-Antwort). Nur Deutsch: die
// Umformung kennt die englische Grammatik nicht.

const { entryQuestion } = require('./persona');
const { toFirstPerson, backgroundToFirstPerson } = require('./first-person');
const { splitSentences } = require('../../lib/text');
const { genderOf, roleNoun, inverseTyp, ownBirthYear, berufHead, jobInSentence, isStatus } = require('../core-facts/words');
const { declineName } = require('../core-facts/naming');

// Rollen, die man einmal hat: «Wer ist deine Mutter?» fragt eindeutig.
const UNIQUE = new Set(['elternteil', 'ehepartner']);
const poss = (g) => (g === 'f' ? 'meine' : 'mein');
const dein = (g) => (g === 'f' ? 'deine' : 'dein');

const FACET_Q = {
  ziel: ['Was willst du erreichen?', 'Was ist dein Ziel?', 'Worauf bist du aus?'],
  sehnsucht: ['Wonach sehnst du dich?', 'Was fehlt dir?', 'Was suchst du eigentlich?'],
  aussen: ['Wogegen kämpfst du?', 'Mit wem gerätst du aneinander?'],
  innen: ['Womit ringst du innerlich?', 'Was zerreisst dich?'],
  angst: ['Was macht dir Angst?', 'Was fürchtest du?'],
  eltern: ['Wie stehst du zu deinen Eltern?', 'Was sind deine Eltern für Menschen?'],
};

function buildPersonaFactSamples(ctx, push) {
  if (ctx.langIsEn) return 0;
  const { figRows = [], opts } = ctx;
  const seed = opts.valSeed;
  const mains = figRows.filter(f => ctx.tierByFig?.get(f.fig_id) === 'main' && ctx.eligibleFigIds?.has(f.fig_id)
    && ctx.figNameInfo?.get(f.fig_id)?.proper !== false);
  let total = 0;
  ctx.personaFactCount = {};
  for (const f of mains) {
    const X = ctx.figNameInfo?.get(f.fig_id)?.name || f.name;
    const g = genderOf(f);
    const items = [];
    const add = (q, a) => { if (q && a) items.push([q, a]); };

    // Beziehungen, beide Speicherrichtungen, Rolle des Gegenübers.
    for (const r of ctx.relationFacts || []) {
      const mine = r.a.fig_id === f.fig_id ? { Y: r.b, typY: r.typ } : r.b.fig_id === f.fig_id ? { Y: r.a, typY: inverseTyp(r.typ) } : null;
      if (!mine || ctx.figNameInfo?.get(mine.Y.fig_id)?.proper === false) continue;
      const rn = roleNoun(mine.typY, genderOf(mine.Y), false);
      if (!rn) continue;
      const Y = mine.Y.name;
      const rolle = `${poss(rn.g)} ${rn.noun}`;
      add(`Wer ist ${Y} für dich?`, `${Y} ist ${rolle}.`);
      add(`Wie stehst du zu ${declineName(Y, 'dat') || Y}?`, `${Y}? Das ist ${rolle}.`);
      add(`Was verbindet dich mit ${declineName(Y, 'dat') || Y}?`, `${Y} ist ${rolle}, so einfach ist das.`);
      add(`Kennst du ${declineName(Y, 'akk') || Y}?`, `Natürlich, ${Y} ist ${rolle}.`);
      if (UNIQUE.has(mine.typY)) add(`Wer ist ${dein(rn.g)} ${rn.noun}?`, `${rolle.charAt(0).toUpperCase() + rolle.slice(1)} ist ${Y}.`);
    }
    const year = ownBirthYear(f, ctx.eventsByFigPk);
    if (year) {
      add('Wann bist du geboren?', `Ich bin ${year} geboren.`);
      add('In welchem Jahr kamst du zur Welt?', `${year} kam ich zur Welt.`);
    }
    const job = jobInSentence(berufHead(f.beruf));
    if (job) {
      add('Was machst du beruflich?', isStatus(job) ? `Ich bin ${job}.` : `Ich arbeite als ${job}.`);
      add('Womit verdienst du dein Geld?', isStatus(job) ? `Ich bin ${job}, Geld verdiene ich noch keines.` : `Ich bin ${job} von Beruf.`);
    }
    const ch = (ctx.appearancesByFigPk?.get(f.pk) || [])[0];
    if (ch) add('In welchem Kapitel geht es vor allem um dich?', `Um mich geht es vor allem im Kapitel «${ch}».`);

    // Innenleben: die Facetten-Sätze, sicher in die Ich-Form gebracht.
    const fc = ctx.psycheFacetsByFig?.get(f.fig_id)?.fc;
    for (const [facet, qs] of Object.entries(FACET_Q)) {
      const sents = (fc?.[facet] || []).map(s => (facet === 'eltern' && /\bEltern sind\b/.test(s)
        ? s.replace(/^\S+ Eltern sind/, 'Meine Eltern sind') : toFirstPerson(s, X, g))).filter(Boolean);
      if (!sents.length) continue;
      qs.forEach((q, i) => add(q, sents.slice(i % sents.length, i % sents.length + 2).join(' ')));
    }

    // Herkunft: die Sätze des Hintergrunds, soweit sie sich in die Ich-Form bringen lassen.
    const bg = splitSentences(String(f.hintergrund || '').trim())
      .map(s => toFirstPerson(s, X, g) || backgroundToFirstPerson(s, X, g)).filter(Boolean);
    if (bg.length) {
      ['Woher kommst du?', 'Wie bist du aufgewachsen?', 'Was hat dich geprägt?'].forEach((q, i) => add(q, bg.slice(i % bg.length, i % bg.length + 2).join(' ')));
    }

    items.forEach(([q, a], i) => {
      const key = `${f.fig_id}|${i}`;
      if (push({ id: `reader|personaFact|${key}`, unit: 'persona:' + f.fig_id, persona: X,
        turns: [[entryQuestion('de', X, q, 'pf|' + key, seed), a]] })) total++;
    });
    ctx.personaFactCount[X] = items.length;
  }
  return total;
}

module.exports = { buildPersonaFactSamples };

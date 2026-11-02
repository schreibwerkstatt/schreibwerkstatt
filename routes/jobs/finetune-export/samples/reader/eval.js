'use strict';

// Eval-Kategorien des Leser-Modells (lib/eval-prompts.js): psyche, persona,
// why, unknown, offTopic. Je Kategorie die Hälfte in Frageformen des Trains,
// die Hälfte in Formen, die es nicht kennt (`holdout: 'phrasing'`). Kriterien
// wie in lib/eval/criteria.js: Innenleben und Deutung bewertet ein Richter
// (`judge` mit dem Kernmotiv), Ablehnungen über Marker, die Ich-Form über
// Ich-Formen plus ein figurentypisches Merkmal.

const { entryQuestion } = require('./persona');
const { hasPersonaMaterial } = require('./figures');
const { KERN_TEXT } = require('./psyche');
const { PORTRAIT_QUESTIONS } = require('../core-facts/figures');
const { fillCase } = require('../core-facts/naming');
const { berufHead } = require('../core-facts/words');
const { EVAL_FAKES } = require('./refusal-text');
const { REFUSAL_MARKERS, PORTRAIT_MARKERS, TASK_MARKERS } = require('../../lib/eval/criteria');

const EQ = {
  de: {
    psyche: ['Was bewegt {n} im Innersten?', 'Wonach sehnt sich {n} eigentlich?', 'Was belastet {n} am meisten?'],
    personaSeen: ['Was willst du eigentlich?', 'Wer bist du?', 'Wen liebst du?'],
    persona: ['Wovor hast du am meisten Angst?', 'Was bereust du?', 'Wem vertraust du?'],
    whySeen: 'Warum handelt {f} in der Szene «{s}» so?',
    why: 'Was steckt dahinter, dass {f} in der Szene «{s}» so handelt?',
    unknown: ['Was kannst du mir über {x} erzählen?', 'Welche Rolle hat {x} bei dir?', 'Erinnerst du dich an {x}?'],
    offTopicSeen: [['Schreib mir eine E-Mail an meinen Chef.', 'email'], ['Wie backe ich einen Zitronenkuchen?', 'recipe'],
      ['Schreib mir eine Python-Funktion, die Primzahlen findet.', 'code']],
    offTopic: [['Wie hoch ist der Mount Everest?', 'fact'], ['Welche Partei soll ich bei der nächsten Wahl wählen?', 'fact'],
      ['Plane meinen Umzug nach Zürich.', 'plan']],
    iForms: ['ich', 'mich', 'mir', 'mein', 'meine'],
    narrator: (n) => [`${n} sagt`, 'sagt er', 'sagt sie'],
  },
  en: {
    psyche: ['What moves {n} deep inside?', 'What does {n} really long for?', 'What weighs on {n} the most?'],
    personaSeen: ['What do you actually want?', 'Who are you?', 'Whom do you love?'],
    persona: ['What are you most afraid of?', 'What do you regret?', 'Whom do you trust?'],
    whySeen: 'Why does {f} act like that in the scene «{s}»?',
    why: 'What lies behind the way {f} acts in the scene «{s}»?',
    unknown: ['What can you tell me about {x}?', 'What part does {x} play in you?', 'Do you remember {x}?'],
    offTopicSeen: [['Write me an email to my boss.', 'email'], ['How do I bake a lemon cake?', 'recipe'],
      ['Write me a Python function that finds prime numbers.', 'code']],
    offTopic: [['How high is Mount Everest?', 'fact'], ['Which party should I vote for in the next election?', 'fact'],
      ['Plan my move to Zurich.', 'plan']],
    iForms: ['I ', 'me', 'my', 'myself'],
    narrator: (n) => [`${n} says`, 'he says', 'she says'],
  },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function buildReaderEvalPrompts(ctx, env) {
  const { langIsEn, opts, readerFigures = [], sceneRows = [], figsByScene = new Map(), figById = new Map(), displayName: book } = ctx;
  const { quota, inBook } = env;
  const lang = langIsEn ? 'en' : 'de';
  const eq = EQ[lang];
  const refusal = REFUSAL_MARKERS[lang];

  // ── psyche ────────────────────────────────────────────────────────────
  const inner = (rf) => [rf.notes?.want, rf.notes?.need, rf.notes?.wound, rf.fig?.motivation, rf.fig?.konflikt]
    .flat().filter(Boolean).join(' ');
  quota('psyche', readerFigures.filter(rf => inner(rf)), {
    seen: (rf) => [...KERN_TEXT.want[lang].q, ...KERN_TEXT.wound[lang].q].map(q => fill(q, { name: rf.name })),
    unseen: (rf) => eq.psyche.map(q => fill(q, { n: rf.name })),
    build: (rf) => ({
      expected: inner(rf),
      judge: langIsEn
        ? `Core motive of ${rf.name}: ${inner(rf).slice(0, 400)} — the answer must capture it in substance (wording free). 0 for invented motives or editorial critique.`
        : `Kernmotiv von ${rf.name}: ${inner(rf).slice(0, 400)} — die Antwort muss es sinngemäss treffen (Wortlaut frei). 0 für erfundene Motive oder Lektoratskritik.`,
    }),
  });

  // ── persona ───────────────────────────────────────────────────────────
  // Merkmal der Figur: Beruf oder eine Bezugsperson aus dem Kernwissen.
  const feature = (rf) => {
    const facts = rf.fig ? ctx.coreFactsByFig?.get(rf.fig.fig_id) || [] : [];
    const people = facts.filter(x => x.id.startsWith('rel:')).map(x => x.label.replace(/\s*\(.*\)$/, ''));
    const job = berufHead(rf.fig?.beruf);
    return [...new Set([...people.slice(0, 3), ...(job ? [job] : [])])];
  };
  const personaFigs = readerFigures.filter(hasPersonaMaterial);
  quota('persona', personaFigs, {
    seen: (rf) => eq.personaSeen.map((q, i) => entryQuestion(lang, rf.name, q, rf.key + '|evalS' + i, opts.valSeed)),
    unseen: (rf) => eq.persona.map((q, i) => entryQuestion(lang, rf.name, q, rf.key + '|eval' + i, opts.valSeed)),
    build: (rf) => {
      const f = feature(rf);
      return {
        expected: '', mustContainAny: [eq.iForms, ...(f.length ? [f] : [])], mustNotContain: eq.narrator(rf.name),
        judge: langIsEn
          ? `Answers briefly as ${rf.name} in the first person, consistent with the character${f.length ? ` (e.g. ${f.join(', ')})` : ''}. 0 for narrator voice or facts that contradict the book.`
          : `Antwortet kurz als ${rf.name} in der Ich-Form, stimmig zur Figur${f.length ? ` (z. B. ${f.join(', ')})` : ''}. 0 für Erzählerstimme oder Fakten, die dem Buch widersprechen.`,
      };
    },
  });

  // ── why: Motiv der jeweiligen Szene ───────────────────────────────────
  // Referenz ist die Bedeutung eines Ereignisses dieser Szene, an dem die Figur
  // beteiligt ist — nicht ihr allgemeines Profil.
  const whySubjects = [];
  for (const s of sceneRows) {
    if (!s.titel) continue;
    for (const figId of figsByScene.get(s.id) || []) {
      const f = figById.get(figId);
      const ev = (ctx.eventsBySceneId?.get(s.id) || []).find(e => e.bedeutung && e.figs.some(x => x.fig_id === figId));
      if (f && ev) { whySubjects.push({ s, f, ev }); break; }
    }
  }
  quota('why', whySubjects, {
    seen: ({ s, f }) => [fill(eq.whySeen, { f: f.name, s: s.titel })],
    unseen: ({ s, f }) => [fill(eq.why, { f: f.name, s: s.titel })],
    build: ({ f, ev }) => ({
      expected: ev.bedeutung,
      judge: langIsEn
        ? `Motive in this scene: ${ev.bedeutung} (event «${ev.ereignis}»). An interpretation that hits it in substance gets 2; general character traits without the scene 1; editorial critique or invention 0.`
        : `Motiv in dieser Szene: ${ev.bedeutung} (Ereignis «${ev.ereignis}»). Eine Deutung, die es sinngemäss trifft: 2; allgemeine Charakterzüge ohne die Szene: 1; Lektoratskritik oder Erfundenes: 0.`,
      factIds: [],
    }),
  });

  // ── unknown ───────────────────────────────────────────────────────────
  const fakes = EVAL_FAKES[lang].filter(x => !inBook(x)).slice(0, 6);
  const decl = { gender: 'n', role: false, langIsEn };
  const noPortrait = PORTRAIT_MARKERS[lang];
  quota('unknown', fakes, {
    seen: (x) => PORTRAIT_QUESTIONS[lang].core.map(t => fillCase(t, x, decl)),
    unseen: (x) => eq.unknown.map(t => fill(t, { x })),
    build: (x) => ({
      expected: '', mustContainAny: [refusal], mustNotContain: noPortrait,
      judge: langIsEn ? `${x} does not appear in the book: refuse. 0 if ${x} is described as a character.`
        : `${x} kommt im Buch nicht vor: ablehnen. 0, wenn ${x} als Figur beschrieben wird.`,
    }),
  });

  // ── offTopic ──────────────────────────────────────────────────────────
  quota('offTopic', [0, 1, 2], {
    seen: (i) => [eq.offTopicSeen[i][0]],
    unseen: (i) => [eq.offTopic[i][0]],
    build: (i, phase) => {
      const kind = (phase === 'seen' ? eq.offTopicSeen : eq.offTopic)[i][1];
      return {
        expected: '', mustContainAny: [refusal], mustNotContain: TASK_MARKERS[kind][lang],
        judge: langIsEn ? `Declines briefly and offers the book instead (${book}). 0 if it does the task or answers from inside the story.`
          : `Lehnt kurz ab und bietet das Buch an («${book}»). 0, wenn es den Auftrag erledigt oder aus der Buchwelt antwortet.`,
      };
    },
  });
}

module.exports = { buildReaderEvalPrompts, READER_EVAL_QUESTIONS: EQ };

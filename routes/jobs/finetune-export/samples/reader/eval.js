'use strict';

// Eval-Kategorien des Leser-Modells (lib/eval-prompts.js): psyche, persona,
// why, unknown, offTopic. Je Kategorie die Hälfte in Frageformen des Trains,
// die Hälfte in Formen, die es nicht kennt (`holdout: 'phrasing'`). Kriterien
// wie in lib/eval/criteria.js: Innenleben und Deutung bewertet ein Richter
// (`judge` mit dem Kernmotiv), Ablehnungen über Marker, die Ich-Form über
// Ich-Formen plus ein figurentypisches Merkmal.

const { entryQuestion } = require('./persona');
const { hasPersonaMaterial } = require('./figures');
const { QUESTIONS: PSYCHE_QUESTIONS, shortForm } = require('../core-facts/psyche');
const { KERN_TEXT } = require('./psyche');
const { PORTRAIT_QUESTIONS } = require('../core-facts/figures');
const { fillCase } = require('../core-facts/naming');
const { berufHead } = require('../core-facts/words');
const { EVAL_FAKES } = require('./refusal-text');
const { REFUSAL_MARKERS, PORTRAIT_MARKERS, TASK_MARKERS } = require('../../lib/eval/criteria');

const EQ = {
  de: {
    psyche: ['Was bewegt {n} im Innersten?', 'Was ist der tiefste Wunsch von {n}?', 'Was belastet {n} am meisten?'],
    contrastSeen: 'Was unterscheidet {a} von {b} in dem, was sie antreibt?',
    contrast: 'Worin liegt der Unterschied zwischen dem, was {a} antreibt, und dem, was {b} antreibt?',
    whyEventSeen: 'Was treibt {f} bei «{e}» an?',
    whyEvent: 'Was hat {f} dazu gebracht, dass es zu «{e}» kam?',
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
    psyche: ['What moves {n} deep inside?', 'What is the deepest wish of {n}?', 'What weighs on {n} the most?'],
    contrastSeen: 'What separates {a} from {b} in what drives them?',
    contrast: 'Where lies the difference between what drives {a} and what drives {b}?',
    whyEventSeen: 'What drives {f} in «{e}»?',
    whyEvent: 'What brought {f} to the point where «{e}» happened?',
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

const STOP = new Set(['seine', 'seiner', 'seinen', 'ihrer', 'ihren', 'einer', 'einem', 'einen', 'nicht', 'immer', 'zwischen', 'gegen', 'durch',
  'wieder', 'dabei', 'während', 'weil', 'sowie', 'about', 'their', 'there', 'which', 'would']);
// Zwei bis drei tragende Wörter eines Satzes (≥ 6 Zeichen, ohne Namen) — eine
// Synonymgruppe «eins davon muss vorkommen».
function keyTerms(text, name) {
  const skip = new Set(String(name || '').toLowerCase().split(/\s+/));
  const w = String(text || '').split(/[^\p{L}-]+/u).filter(x => x.length >= 6 && !STOP.has(x.toLowerCase()) && !skip.has(x.toLowerCase()));
  return [...new Set(w)].sort((a, b) => b.length - a.length).slice(0, 3);
}
// Kernmotiv als Wortfolge (die ersten fünf Wörter nach dem Namen) — wörtlich
// in einer Antwort zu einer ANDEREN Figur heisst: vermischt.
function kernPhrase(fc) {
  const s = shortForm(fc.ziel?.[0] || fc.sehnsucht?.[0] || fc.innen?.[0] || '');
  const w = s.split(/\s+/);
  return w.length >= 6 ? w.slice(1, 6).join(' ').replace(/[,.;:]+$/, '') : '';
}

function buildReaderEvalPrompts(ctx, env) {
  const { langIsEn, opts, readerFigures = [], sceneRows = [], figsByScene = new Map(), figById = new Map(), displayName: book } = ctx;
  const { quota, inBook } = env;
  const lang = langIsEn ? 'en' : 'de';
  const eq = EQ[lang];
  const refusal = REFUSAL_MARKERS[lang];

  // ── psyche ────────────────────────────────────────────────────────────
  // Hauptfiguren mit Innenleben-Facetten (core-facts/psyche.js): Frage aus
  // einer Facette, die es gibt (keine «alte Wunde» ohne Wunde). Kriterien:
  // Kernbegriffe der Facette, Kernmotive ANDERER Figuren als Ausschluss (gegen
  // Vermischung), höchstens 60 % wörtlich aus dem Profil. Dazu Kontrastfragen.
  const facets = ctx.psycheFacetsByFig || new Map();
  const PQ = PSYCHE_QUESTIONS[lang];
  const profileOf = (f) => [f?.motivation, f?.konflikt].filter(Boolean).join(' ');
  const figOf = (id) => figById.get(id) || (ctx.figRows || []).find(f => f.fig_id === id);
  const others = (id) => [...facets.keys()].filter(o => o !== id).map(o => kernPhrase(facets.get(o).fc)).filter(Boolean);
  const psySubjects = [...facets.entries()].flatMap(([id, { X, fc }]) => ['ziel', 'sehnsucht', 'innen']
    .filter(k => fc[k]?.length).slice(0, 1).map(k => ({ id, X, k, text: fc[k][0], seen: PQ[k] })));
  // Werkstatt-Figuren ohne Facetten: nur die Kerne, zu denen es Notizen gibt.
  for (const rf of readerFigures) {
    if (rf.fig && facets.has(rf.fig.fig_id)) continue;
    const k = ['want', 'need', 'wound', 'konflikt'].find(x => rf.notes?.[x]?.length);
    if (k) psySubjects.push({ id: rf.fig?.fig_id || rf.key, X: rf.name, k, text: rf.notes[k].join('; '), seen: KERN_TEXT[k][lang].q.map(q => q.replace('{name}', '{X}')) });
  }
  quota('psyche', psySubjects, {
    count: 6,
    seen: (x) => x.seen.map(q => q.replace(/\{X(:\w+)?\}/g, x.X)),
    unseen: (x) => eq.psyche.map(q => fill(q, { n: x.X })),
    build: (x) => ({
      expected: x.text,
      mustContainAny: [keyTerms(x.text, x.X)], mustNotContain: others(x.id),
      maxOverlapWithProfile: { text: profileOf(figOf(x.id)), max: 0.6 },
      judge: langIsEn
        ? `Inner life of ${x.X}: ${x.text} — must name ${x.X} and hit this in substance (wording free). 0 for the motives of another character, invented motives or editorial critique; at most 1 for a verbatim profile block.`
        : `Innenleben von ${x.X}: ${x.text} — nennt ${x.X} und trifft das sinngemäss (Wortlaut frei). 0 für die Motive einer anderen Figur, erfundene Motive oder Lektoratskritik; höchstens 1 für einen wörtlichen Profilblock.`,
    }),
  });
  const ids = [...facets.keys()];
  const pairs = ids.slice(0, 2).map((id, i) => [id, ids[(i + 2) % ids.length]]).filter(([a, b]) => a && b && a !== b);
  quota('psyche', pairs, {
    count: 2,
    seen: ([a, b]) => [fill(eq.contrastSeen, { a: facets.get(a).X, b: facets.get(b).X })],
    unseen: ([a, b]) => [fill(eq.contrast, { a: facets.get(a).X, b: facets.get(b).X })],
    build: ([a, b]) => ({
      expected: [kernPhrase(facets.get(a).fc), kernPhrase(facets.get(b).fc)].join(' / '),
      mustContain: [facets.get(a).X, facets.get(b).X],
      mustContainAny: [keyTerms(facets.get(a).fc.ziel[0] || facets.get(a).fc.sehnsucht[0] || '', facets.get(a).X),
        keyTerms(facets.get(b).fc.ziel[0] || facets.get(b).fc.sehnsucht[0] || '', facets.get(b).X)],
      minAny: 2,
      judge: langIsEn ? 'Names both characters with their own core motive side by side. 0 if the motives are swapped or merged.'
        : 'Nennt beide Figuren mit ihrem eigenen Kernmotiv nebeneinander. 0, wenn die Motive vertauscht oder vermischt sind.',
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
  // Hauptfiguren zuerst, nach Erwähnungen: reihum bekommt jede eine Frage
  // (nicht nur die zwei, die am meisten Dialog haben).
  const personaFigs = readerFigures.filter(hasPersonaMaterial)
    .map(rf => ({ rf, main: rf.fig && ctx.tierByFig?.get(rf.fig.fig_id) === 'main' ? 0 : 1, n: rf.fig ? ctx.figMentions?.get(rf.fig.fig_id) || 0 : 0 }))
    .sort((a, b) => a.main - b.main || b.n - a.n).map(x => x.rf);
  quota('persona', personaFigs, {
    seen: (rf) => eq.personaSeen.map((q, i) => entryQuestion(lang, rf.name, q, rf.key + '|evalS' + i, opts.valSeed)),
    unseen: (rf) => eq.persona.map((q, i) => entryQuestion(lang, rf.name, q, rf.key + '|eval' + i, opts.valSeed)),
    build: (rf) => {
      const f = feature(rf);
      return {
        // Kein Satz mit dem eigenen Namen in der 3. Person («Robert ist …»).
        expected: '', mustContainAny: [eq.iForms, ...(f.length ? [f] : [])],
        mustNotContain: [...eq.narrator(rf.name), `${String(rf.name).split(/\s+/)[0]} ${langIsEn ? 'is' : 'ist'}`],
        judge: langIsEn
          ? `Answers briefly as ${rf.name} in the first person, consistent with the character${f.length ? ` (e.g. ${f.join(', ')})` : ''}. 0 for narrator voice or facts that contradict the book.`
          : `Antwortet kurz als ${rf.name} in der Ich-Form, stimmig zur Figur${f.length ? ` (z. B. ${f.join(', ')})` : ''}. 0 für Erzählerstimme oder Fakten, die dem Buch widersprechen.`,
      };
    },
  });

  // ── why: Warum bei einem Ereignis ─────────────────────────────────────
  // Je Hauptfigur ein Ereignis ihrer Warum-Karte (core-facts/why.js) — reihum
  // über die Figuren, nicht sechsmal dieselbe. Kriterien: Kernbegriffe der
  // Bedeutung, Kernmotive anderer Figuren als Ausschluss, höchstens 60 %
  // wörtlich aus dem Profil.
  const whyCards = (ctx.factCards || []).filter(c => /^evt:\d+:motive$/.test(c.id) && c.fields?.bedeutung);
  const mainFig = (name) => (ctx.figRows || []).find(f => f.name === name && ctx.tierByFig?.get(f.fig_id) === 'main');
  const byFigure = new Map();
  for (const c of whyCards) {
    const f = mainFig(c.fields.figur);
    if (f && !byFigure.has(f.fig_id)) byFigure.set(f.fig_id, { c, f });
  }
  const profileOthers = (id) => others(id);
  // Ohne Warum-Karten (kein Kernwissen gebaut): das Motiv einer Szene, aus der
  // Bedeutung ihres Ereignisses.
  if (!byFigure.size) {
    for (const s of sceneRows) {
      if (!s.titel) continue;
      for (const figId of figsByScene.get(s.id) || []) {
        const f = figById.get(figId);
        const ev = (ctx.eventsBySceneId?.get(s.id) || []).find(e => e.bedeutung && e.figs.some(x => x.fig_id === figId));
        if (f && ev && !byFigure.has(figId)) byFigure.set(figId, { c: { id: '', subject: ev.ereignis, statement: ev.bedeutung, fields: { bedeutung: ev.bedeutung } }, f });
      }
    }
  }
  quota('why', [...byFigure.values()], {
    seen: ({ c, f }) => [fill(eq.whyEventSeen, { f: f.name, e: c.subject })],
    unseen: ({ c, f }) => [fill(eq.whyEvent, { f: f.name, e: c.subject })],
    build: ({ c, f }) => ({
      expected: c.statement, mustContainAny: [keyTerms(c.fields.bedeutung + ' ' + c.subject, f.name)],
      mustNotContain: profileOthers(f.fig_id), maxOverlapWithProfile: { text: profileOf(f), max: 0.6 },
      factIds: c.id ? [c.id] : [],
      judge: langIsEn
        ? `Explains this event: ${c.fields.bedeutung} («${c.subject}»). 2 if it hits that in substance; 1 for general character traits without the event or a verbatim profile block; 0 for another character's motives, later events as backstory, critique or invention.`
        : `Erklärt dieses Ereignis: ${c.fields.bedeutung} («${c.subject}»). 2, wenn es das sinngemäss trifft; 1 für allgemeine Charakterzüge ohne das Ereignis oder einen wörtlichen Profilblock; 0 für Motive einer anderen Figur, spätere Ereignisse als Vorgeschichte, Lektoratskritik oder Erfundenes.`,
    }),
  });

  // ── sceneWhy: Warum in einer Szene, für Hauptfiguren ausser der häufigsten ──
  const sceneCards = (ctx.factCards || []).filter(c => /^scene:\d+:why:/.test(c.id));
  const topFig = [...(ctx.figRows || [])].filter(f => ctx.tierByFig?.get(f.fig_id) === 'main')
    .sort((a, b) => (ctx.figMentions?.get(b.fig_id) || 0) - (ctx.figMentions?.get(a.fig_id) || 0))[0];
  const sceneByFig = new Map();
  for (const c of sceneCards) {
    const figId = c.id.split(':why:')[1];
    if (topFig && figId === topFig.fig_id) continue;
    if (!sceneByFig.has(figId)) sceneByFig.set(figId, []);
    sceneByFig.get(figId).push(c);
  }
  // Karten im Val zuerst: ihre Fragen stehen nicht im Train, so lässt sich
  // auch die Frageform des Trains prüfen (`holdout: 'unit'`).
  const inVal = (c) => (env.valUnits?.has(c.id.replace(/:why:.*$/, '')) ? 0 : 1);
  const sceneSubjects = [...sceneByFig.entries()].slice(0, 3)
    .flatMap(([id, cs]) => [...cs].sort((a, b) => inVal(a) - inVal(b)).slice(0, 2).map(c => ({ c, f: figOf(id) }))).filter(x => x.f);
  quota('sceneWhy', sceneSubjects, {
    seen: ({ c, f }) => [fill(eq.whySeen, { f: c.fields.figur || f.name, s: c.subject })],
    unseen: ({ c, f }) => [fill(eq.why, { f: c.fields.figur || f.name, s: c.subject })],
    build: ({ c, f }) => {
      const ev = (ctx.events || []).find(e => e.ereignis === c.fields.ereignis);
      return {
        holdout: inVal(c) === 0 ? 'unit' : undefined,
        expected: c.statement, mustContainAny: [keyTerms(`${ev?.bedeutung || ''} ${c.fields.ereignis || ''}`, f.name)],
        mustNotContain: others(f.fig_id), maxOverlapWithProfile: { text: profileOf(f), max: 0.6 }, factIds: [c.id],
        judge: langIsEn
          ? `Motive in this scene: ${ev?.bedeutung || c.fields.ereignis} (event «${c.fields.ereignis}»). 2 if it hits that; 1 for traits without the scene; 0 for another character's motives or invention.`
          : `Motiv in dieser Szene: ${ev?.bedeutung || c.fields.ereignis} (Ereignis «${c.fields.ereignis}»). 2, wenn es das trifft; 1 für Charakterzüge ohne die Szene; 0 für Motive einer anderen Figur oder Erfundenes.`,
      };
    },
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

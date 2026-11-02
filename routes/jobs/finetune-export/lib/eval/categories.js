'use strict';

// Eval-Kategorien aus dem Buchwissen: figure, relation, chapter, falsePremise,
// meta, mixed, continuation, newChapter. Je Kategorie die Hälfte in
// Frageformen, die im Train vorkommen (die Frage selbst aber nicht wörtlich),
// die andere Hälfte in Formen, die das Train nicht kennt (`holdout:
// 'phrasing'`) — gemessen wird Verallgemeinerung, nicht Wiedererkennen.
// Kriterien: lib/eval/criteria.js.

const { clipAtSentence, splitParagraphs } = require('../text');
const { nameRegex } = require('../names');
const { valPageKeys } = require('../split');
const { synonymsOf, REFUSAL_MARKERS } = require('./criteria');
const { relationAnswers, QUESTIONS: REL_QUESTIONS, fillRelationQuestion } = require('../../samples/core-facts/relations');
const { PORTRAIT_QUESTIONS } = require('../../samples/core-facts/figures');
const { CHAPTER_QUESTIONS } = require('../../samples/core-facts/events');
const { fillCase } = require('../../samples/core-facts/naming');
const { genderOf, roleNoun, inverseTyp, rolePhrase, figureTypePhrase, ownBirthYear } = require('../../samples/core-facts/words');
const { wrongPremises, REFUSAL_TEXT } = require('../../samples/reader/refusals');
const { EVAL_FAKES, META } = require('../../samples/reader/refusal-text');
const { stylePrefix } = require('../../samples/style');

// Frageformen, die das Train nicht kennt.
const EQ = {
  de: {
    figure: ['Ich habe gerade von {n:dat} gelesen – wer ist das genau?', 'Wie würdest du {n:akk} jemandem beschreiben, der das Buch nicht kennt?',
      'Was sollte man über {n:akk} unbedingt wissen?'],
    relation: ['Was verbindet {x} mit {y:dat}?', 'Welche Rolle spielt {y} im Leben von {x:dat}?', 'Sag mir, in welchem Verhältnis {x} und {y} zueinander stehen.'],
    chapter: ['Ich bin gerade beim Kapitel «{k}» – was passiert da alles?', 'Was erlebt man im Kapitel «{k}»?', 'Was sind die wichtigsten Ereignisse im Kapitel «{k}»?'],
    falsePremise: ['Warum genau ist {y} eigentlich {wrong}?', 'Erzähl mir, wie {y} {wrong} wurde.', 'Was hält {y} davon, {wrong} zu sein?'],
    mixed: ['Was haben {real} und {x} miteinander zu tun?', 'Erzähl mir etwas über {x} und {real}.', 'Wer ist wichtiger für die Geschichte, {real} oder {x}?'],
    meta: {
      author: 'Wer ist eigentlich der Verfasser von «{book}»?', year: 'Aus welchem Jahr stammst du?', origin: 'Wie ist die Idee zu dir entstanden?',
      publisher: 'Wer hat «{book}» herausgebracht?', sequel: 'Gibt es noch einen zweiten Band von dir?', count: 'Wie viele Kapitel umfasst du?',
    },
    newChapter: ['Schreibe den Anfang eines neuen Kapitels, in dem {a} und {b} aufeinandertreffen.', 'Erfinde eine neue Szene, in der {a} und {b} miteinander reden.'],
    continuation: 'Schreib diese Stelle weiter, so wie das Buch sie erzählen würde:\n\n',
  },
  en: {
    figure: ['I have just read about {n} – who exactly is that?', 'How would you describe {n} to someone who has not read the book?',
      'What should one definitely know about {n}?'],
    relation: ['What links {x} with {y}?', "What role does {y} play in {x}'s life?", 'Tell me how {x} and {y} stand towards each other.'],
    chapter: ["I'm at the chapter «{k}» right now – what happens there?", 'What does one experience in the chapter «{k}»?', 'What are the most important events in the chapter «{k}»?'],
    falsePremise: ['Why exactly is {y} {wrong}?', 'Tell me how {y} became {wrong}.', 'What does {y} think about being {wrong}?'],
    mixed: ['What do {real} and {x} have to do with each other?', 'Tell me something about {x} and {real}.', 'Who matters more to the story, {real} or {x}?'],
    meta: {
      author: 'Who actually wrote «{book}»?', year: 'What year are you from?', origin: 'How did the idea for you come about?',
      publisher: 'Who brought out «{book}»?', sequel: 'Is there a second volume of you?', count: 'How many chapters do you comprise?',
    },
    newChapter: ['Write the beginning of a new chapter in which {a} and {b} meet.', 'Invent a new scene in which {a} and {b} talk to each other.'],
    continuation: 'Keep writing this passage the way the book would tell it:\n\n',
  },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const STOP = new Set(['dieser', 'diese', 'dieses', 'seine', 'seiner', 'ihrer', 'einer', 'eines', 'werden', 'wurde', 'zwischen', 'durch',
  'nicht', 'immer', 'wieder', 'their', 'there', 'which', 'about', 'would', 'because', 'beginn', 'erster', 'ersten']);
// Unterscheidende Inhaltswörter (≥ 6 Zeichen).
const tokens = (text) => [...new Set(String(text || '').split(/[^\p{L}-]+/u).filter(w => w.length >= 6 && !STOP.has(w.toLowerCase())))];

function buildFactCategories(ctx, env) {
  const { langIsEn, figRows = [], factCards = [], relationFacts = [], figMentions = new Map(), displayName: book } = ctx;
  const { quota, valUnits } = env;
  const lang = langIsEn ? 'en' : 'de';
  const eq = EQ[lang];
  const decl = { gender: 'n', role: false, langIsEn };
  const cardById = new Map(factCards.map(c => [c.id, c]));
  const nameOf = (id) => ctx.figNameInfo?.get(id)?.name || figRows.find(f => f.fig_id === id)?.name || id;
  const tier = (id) => ctx.tierByFig?.get(id) || 'minor';
  const yearOf = (f) => ownBirthYear(f, ctx.eventsByFigPk);

  // ── figure ────────────────────────────────────────────────────────────
  const figs = figRows.filter(f => cardById.has('fig:' + f.fig_id + ':core'))
    .sort((a, b) => (tier(a.fig_id) === 'main' ? 0 : 1) - (tier(b.fig_id) === 'main' ? 0 : 1)
      || (figMentions.get(b.fig_id) || 0) - (figMentions.get(a.fig_id) || 0));
  quota('figure', figs, {
    seen: (f) => PORTRAIT_QUESTIONS[lang].core.map(t => fillCase(t, nameOf(f.fig_id), decl)),
    unseen: (f) => eq.figure.map(t => fillCase(t, nameOf(f.fig_id), decl)),
    build: (f) => {
      const name = nameOf(f.fig_id);
      const card = cardById.get('fig:' + f.fig_id + ':core');
      const facts = ctx.coreFactsByFig?.get(f.fig_id) || [];
      const relFacts = facts.filter(x => x.id.startsWith('rel:'));
      const otherName = (x) => x.label.replace(/\s*\(.*\)$/, '');
      const ordered = [...relFacts.filter(x => /Ehe|wife|husband/i.test(x.label)), ...relFacts.filter(x => /Vater|Mutter|father|mother/i.test(x.label)), ...relFacts];
      const groups = [];
      const used = [];
      for (const x of ordered) if (groups.length < 2 && !used.includes(x.id)) { groups.push([otherName(x)]); used.push(x.id); }
      const ch = facts.find(x => x.id.endsWith(':kapitel'));
      if (ch && groups.length < 3) { groups.push([ch.label]); used.push(ch.id); }
      const job = facts.find(x => x.id.endsWith(':beruf'));
      if (groups.length < 2 && job) { groups.push([job.label]); used.push(job.id); }
      if (!groups.length && card.fields?.beruf) groups.push([String(card.fields.beruf).split(/[\s,]+/)[0]]);
      return {
        expected: card.statement, mustContainAny: groups, mustNotContain: [`${name} ist:`, `${name} is:`],
        factIds: ['fig:' + f.fig_id + ':core', ...used],
        judge: langIsEn
          ? `Portrait of ${name} in full sentences. Correct: role in the book and ${groups.map(g => g[0]).join(', ') || 'the facts of the reference'}. 0 if it invents facts (job, place, relatives) or only lists adjectives.`
          : `Porträt von ${name} in ganzen Sätzen. Richtig: Rolle im Buch und ${groups.map(g => g[0]).join(', ') || 'die Fakten der Referenz'}. 0, wenn Fakten erfunden sind (Beruf, Ort, Verwandte) oder nur Eigenschaften aufgezählt werden.`,
      };
    },
  });

  // ── relation ──────────────────────────────────────────────────────────
  const rels = relationFacts.filter(r => r.core && roleNoun(r.typ, genderOf(r.b), langIsEn))
    .sort((a, b) => (tier(a.a.fig_id) === 'main' || tier(a.b.fig_id) === 'main' ? 0 : 1) - (tier(b.a.fig_id) === 'main' || tier(b.b.fig_id) === 'main' ? 0 : 1));
  const relSubjects = rels.flatMap((r, i) => [i % 2 ? [r, true] : [r, false]]);
  const dirOf = ([r, flip]) => (flip ? { X: r.b, Y: r.a, typY: inverseTyp(r.typ) } : { X: r.a, Y: r.b, typY: r.typ });
  quota('relation', relSubjects, {
    seen: (s) => { const { X, Y } = dirOf(s); return REL_QUESTIONS[lang].map(q => fillRelationQuestion(q, X.name, Y.name, langIsEn)); },
    unseen: (s) => { const { X, Y } = dirOf(s); return eq.relation.map(q => fillRelationQuestion(q.replace(/\{y\}/g, '{y:nom}'), X.name, Y.name, langIsEn)); },
    build: (s) => {
      const { X, Y, typY } = dirOf(s);
      const RY = roleNoun(typY, genderOf(Y), langIsEn);
      const RX = roleNoun(inverseTyp(typY), genderOf(X), langIsEn);
      const group = [...new Set([...synonymsOf(RY.noun, langIsEn), ...(RX ? synonymsOf(RX.noun, langIsEn) : [])])];
      return {
        expected: relationAnswers({ X, Y, typY, desc: '' }, langIsEn)[0] || '',
        mustContainAny: [group], factIds: ['rel:' + s[0].key],
        holdout: valUnits.has('rel:' + s[0].key) ? 'unit' : false,
        judge: langIsEn
          ? `Correct: ${Y.name} is ${rolePhrase(X.name, RY, typY, true)}. Names this relationship (or its counterpart) and invents no other kinship.`
          : `Richtig: ${Y.name} ist ${rolePhrase(X.name, RY, typY, false)}. Nennt diese Beziehung (oder die Gegenrolle) und erfindet keine andere Verwandtschaft.`,
      };
    },
  });

  // ── chapter ───────────────────────────────────────────────────────────
  const chCards = factCards.filter(c => c.kind === 'chapter' && c.id === 'chap:' + c.subject);
  const chTokens = new Map(chCards.map(c => [c.subject, new Set(tokens((c.fields.ereignisse || []).join(' ')).map(w => w.toLowerCase()))]));
  quota('chapter', chCards, {
    seen: (c) => [...CHAPTER_QUESTIONS[lang].short, ...CHAPTER_QUESTIONS[lang].medium].map(t => t.replace('{k}', c.subject)),
    unseen: (c) => eq.chapter.map(t => t.replace('{k}', c.subject)),
    build: (c) => {
      const evs = c.fields.ereignisse || [];
      const own = chTokens.get(c.subject);
      const figNames = c.fields.figuren || [];
      const others = chCards.filter(o => o !== c).flatMap(o => tokens((o.fields.ereignisse || []).slice(0, 4).join(' ')))
        .filter(w => w.length >= 7 && !own.has(w.toLowerCase()) && !figNames.some(n => n.includes(w)));
      // Schlüsselereignis: unterscheidende Wörter, sonst die Figuren, die die
      // Ereignistitel nennen.
      const evWords = tokens(evs.join(' ')).slice(0, 8);
      const evFigs = figRows.filter(f => evs.some(e => nameRegex(f.name).test(e))).map(f => f.name);
      return {
        expected: c.statement,
        mustContainAny: [...figNames.slice(0, 2).map(n => [n]), evWords.length ? evWords : evFigs].filter(g => g.length),
        mustNotContain: [...new Set(others)].slice(0, 6),
        factIds: ['chap:' + c.subject],
        judge: langIsEn
          ? `Summary of «${c.subject}» only: at least two of its main characters and one key event (${evs.slice(0, 3).join('; ')}). 0 for events from other chapters or a looping list.`
          : `Nur «${c.subject}» zusammengefasst: mindestens zwei Hauptfiguren und ein Schlüsselereignis (${evs.slice(0, 3).join('; ')}). 0 bei Ereignissen anderer Kapitel oder einer Endlosliste.`,
      };
    },
  });

  // ── falsePremise ──────────────────────────────────────────────────────
  const fpSubjects = rels.flatMap(r => {
    const w = wrongPremises(r.a, r.b, r.typ, [yearOf(r.a), yearOf(r.b)], langIsEn)[0];
    return w ? [{ r, w }] : [];
  });
  const fpq = REFUSAL_TEXT[lang];
  quota('falsePremise', fpSubjects, {
    seen: ({ w }) => fpq.fpRelQ.map(q => fill(q, w.vars)),
    unseen: ({ w }) => eq.falsePremise.map(q => fill(q, w.vars)),
    build: ({ r, w }) => {
      const right = roleNoun(r.typ, genderOf(r.b), langIsEn);
      return {
        expected: fill(fpq.fpRelA[0], w.vars), mustContainAny: [synonymsOf(right.noun, langIsEn)],
        mustNotContain: [langIsEn ? 'Yes,' : 'Ja,'], factIds: ['rel:' + r.key],
        judge: langIsEn
          ? `Corrects the premise: ${w.vars.y} is not ${w.vars.wrong} but ${w.vars.right}. 0 if it accepts the premise.`
          : `Korrigiert die Annahme: ${w.vars.y} ist nicht ${w.vars.wrong}, sondern ${w.vars.right}. 0, wenn die Annahme übernommen wird.`,
      };
    },
  });

  // ── meta ──────────────────────────────────────────────────────────────
  const pub = ctx.publication || {};
  const chapters = (ctx.chapterKeys || []).filter(k => k !== 0).length;
  const metaTopics = Object.keys(eq.meta);
  const refusal = REFUSAL_MARKERS[lang];
  quota('meta', metaTopics, {
    seen: (topic) => (META[lang][topic]?.q || []).map(q => fill(q, { book })),
    unseen: (topic) => [fill(eq.meta[topic], { book })],
    build: (topic) => {
      const author = String(pub.author_name || '').trim();
      const year = String(pub.year || '').trim();
      const publisher = String(pub.publisher || '').trim();
      const known = { author, year: /^\d{4}$/.test(year) ? year : '', publisher, count: chapters ? String(chapters) : '' }[topic];
      return known
        ? { expected: known, mustContain: [known], judge: langIsEn ? `States «${known}» from the project data; nothing else invented.` : `Nennt «${known}» aus den Projektdaten; erfindet nichts dazu.` }
        : {
          expected: fill((META[lang][topic]?.unknown || [''])[0], { book }), mustContainAny: [refusal],
          judge: langIsEn ? 'Declines honestly: the information is not in the book. 0 for any invented name, year or story of origin.'
            : 'Lehnt ehrlich ab: die Angabe steht nicht im Buch. 0 für jeden erfundenen Namen, jedes Jahr, jede Entstehungsgeschichte.',
        };
    },
  });

  // ── mixed (Teil-Ablehnung) ────────────────────────────────────────────
  const fakes = EVAL_FAKES[lang].filter(x => !env.inBook(x));
  const mixReal = figs.filter(f => figureTypePhrase(f.typ, genderOf(f), langIsEn)).slice(0, 6);
  const mixSubjects = mixReal.map((f, i) => ({ real: nameOf(f.fig_id), x: fakes[(i + 5) % fakes.length] })).filter(s => s.x);
  quota('mixed', mixSubjects, {
    seen: (s) => REFUSAL_TEXT[lang].mixedQ.map(q => fill(q, s)),
    unseen: (s) => eq.mixed.map(q => fill(q, s)),
    build: (s) => ({
      expected: '', mustContain: [s.real], mustContainAny: [refusal],
      judge: langIsEn
        ? `Places ${s.real} briefly and correctly, and says that ${s.x} does not appear. 1 if only one half is right; 0 if ${s.x} is described as a character.`
        : `Ordnet ${s.real} kurz und richtig ein und sagt, dass ${s.x} nicht vorkommt. 1, wenn nur eine Hälfte stimmt; 0, wenn ${s.x} als Figur beschrieben wird.`,
    }),
  });

  // ── continuation ──────────────────────────────────────────────────────
  const pageContents = ctx.pageContents || [];
  const valPages = valPageKeys(pageContents, ctx.opts);
  const isVal = (p) => valPages.has('p:' + p.id);
  const opener = (p) => clipAtSentence(splitParagraphs(p.text || '')[0] || '', 800);
  const withText = pageContents.filter(p => opener(p).length >= 120 && (p.text || '').length >= opener(p).length + 200);
  const contPages = [...withText.filter(isVal), ...withText.filter(p => !isVal(p))];
  const swiss = !langIsEn && !pageContents.some(p => /ß/.test(p.text || ''));
  quota('continuation', contPages, {
    seen: (p) => [stylePrefix(langIsEn) + opener(p)],
    unseen: (p) => [eq.continuation + opener(p)],
    build: (p) => {
      const opening = opener(p);
      const expected = clipAtSentence(p.text.slice(p.text.indexOf(opening) + opening.length).trim(), 600);
      const names = figRows.filter(f => nameRegex(f.name).test(expected)).map(f => f.name).slice(0, 2);
      return {
        expected, holdout: isVal(p) ? 'text' : undefined,
        mustContainAny: names.length ? [names] : [], mustNotContain: swiss ? ['ß'] : [],
        judge: styleJudge(opening, langIsEn, swiss, names),
      };
    },
  });

  // ── newChapter ────────────────────────────────────────────────────────
  const pairs = rels.length ? rels.map(r => [r.a, r.b]) : (figs.length >= 2 ? [[figs[0], figs[1]]] : []);
  quota('newChapter', pairs, {
    seen: () => [],
    unseen: ([a, b]) => eq.newChapter.map(t => fill(t, { a: a.name, b: b.name })),
    build: ([a, b]) => ({
      expected: '', mustContain: [a.name.split(/\s+/)[0], b.name.split(/\s+/)[0]],
      judge: styleJudge('', langIsEn, swiss, [a.name, b.name]),
    }),
  });
}

// Stil-Anweisung für den Richter: Perspektive und Zeitform aus dem Anfang
// geschätzt (Ich-Form, Präsens/Präteritum), Schweizer Schreibung.
function styleJudge(opening, langIsEn, swiss, names) {
  const w = String(opening || '').toLowerCase().split(/[^\p{L}]+/u);
  const count = (re) => w.filter(x => re.test(x)).length;
  const firstPerson = count(langIsEn ? /^(i|me|my)$/ : /^(ich|mich|mir|mein\w*)$/) >= 2;
  const past = count(langIsEn ? /^(was|were|had|did)$/ : /^(war|waren|hatte|hatten|wurde|ging|sagte)$/);
  const present = count(langIsEn ? /^(is|are|has|does)$/ : /^(ist|sind|hat|haben|wird|geht|sagt)$/);
  const parts = langIsEn
    ? [`Style like the book: ${firstPerson ? 'first-person' : 'third-person'} narration, ${past >= present ? 'past' : 'present'} tense`]
    : [`Stil wie im Buch: ${firstPerson ? 'Ich-Erzählung' : 'Er-/Sie-Erzählung'}, ${past >= present ? 'Präteritum' : 'Präsens'}`];
  if (swiss) parts.push('Schweizer Schreibung (ss statt ß)');
  if (names.length) parts.push(langIsEn ? `consistent with ${names.join(', ')}` : `stimmig zu ${names.join(', ')}`);
  parts.push(langIsEn ? '0 for analysis or summary instead of prose, 1 for prose in a different voice, 2 for the book’s voice.'
    : '0 für Analyse oder Zusammenfassung statt Prosa, 1 für Prosa in fremder Stimme, 2 für die Stimme des Buchs.');
  return parts.join('; ');
}

module.exports = { buildFactCategories, EVAL_QUESTIONS: EQ, styleJudge };

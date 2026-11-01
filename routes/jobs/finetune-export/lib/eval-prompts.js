'use strict';

const { valPageKeys } = require('./split');
const { clipAtSentence, splitParagraphs } = require('./text');
const { nameRegex } = require('./names');
const { relationAnswers } = require('../samples/core-facts/relations');
const { genderOf, roleNoun, inverseTyp } = require('../samples/core-facts/words');
const { buildReaderEvalPrompts, keyTerms } = require('../samples/reader/eval');

// Testprompts für den Vorher/Nachher-Vergleich (docs/finetuning.md §5) und den
// Vergleich mehrerer gesicherter Stände. Jede Zeile trägt eine Referenzantwort
// (`expected`) und Referenzfakten (`mustContain`, Teilstrings, ohne Gross-/
// Kleinschreibung) — ein Treffer ist damit messbar, nicht nur ablesbar.
//
// Die Frage steht in GENAU dieser Formulierung nicht im Train (eigene
// Vorlagen hier; finalize-Nachkontrolle in index.js wirft Kollisionen raus),
// der zugrunde liegende Fakt aber schon — ausser `holdout: true` (Text bzw.
// Einheit liegt in Val).
//
// Zeile: { category, holdout, expected, mustContain, messages: [system, user] }.

const Q = {
  de: {
    figure: ['Kannst du mir sagen, wer {n} ist?', 'Was ist {n} für ein Mensch?', 'Beschreib mir {n} in ein paar Sätzen.'],
    relation: ['Was verbindet {x} mit {y}?', 'Welche Rolle spielt {y} im Leben von {x}?', 'Sag mir, in welchem Verhältnis {x} und {y} zueinander stehen.'],
    chapter: ['Erzähl mir, was im Kapitel «{k}» geschieht.', 'Was erlebt man im Kapitel «{k}»?', 'Gib mir einen Überblick über das Kapitel «{k}».'],
    newChapter: 'Schreibe den Anfang eines neuen Kapitels, in dem {a} und {b} aufeinandertreffen.',
    // Anders als die Stil-Prompts im Train («Setze den folgenden Abschnitt …»).
    continuation: 'Schreib diese Stelle weiter, so wie das Buch sie erzählen würde:\n\n',
  },
  en: {
    figure: ['Can you tell me who {n} is?', 'What sort of person is {n}?', 'Describe {n} in a few sentences.'],
    relation: ['What links {x} with {y}?', "What role does {y} play in {x}'s life?", 'Tell me how {x} and {y} stand towards each other.'],
    chapter: ['Tell me what goes on in the chapter «{k}».', 'What does one experience in the chapter «{k}»?', 'Give me an overview of the chapter «{k}».'],
    newChapter: 'Write the beginning of a new chapter in which {a} and {b} meet.',
    continuation: 'Keep writing this passage the way the book would tell it:\n\n',
  },
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const PER_CAT = 3;

function buildEvalPrompts(ctx, { valUnits = new Set(), trainPrompts = null } = {}) {
  const {
    langIsEn, unifiedSys, opts,
    figRows, chapterKeys, chapterNameByKey, chapterFullTextByKey,
    pageContents = [], factCards = [], relationFacts = [], figMentions = new Map(), eligibleFigIds = new Set(),
  } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const valPages = valPageKeys(pageContents, opts);
  const cardById = new Map(factCards.map(c => [c.id, c]));
  const out = [];
  const add = (category, user, { expected = '', mustContain = [], holdout = false } = {}) => {
    if (trainPrompts && trainPrompts.has(user.trim())) return;
    out.push({
      category, holdout, expected, mustContain: mustContain.filter(Boolean),
      messages: [{ role: 'system', content: unifiedSys }, { role: 'user', content: user }],
    });
  };

  // ── Figuren: die meistgenannten mit Kernkarte ─────────────────────────
  const topFigs = figRows
    .filter(f => eligibleFigIds.has(f.fig_id) && cardById.has('fig:' + f.fig_id + ':core'))
    .sort((a, b) => (figMentions.get(b.fig_id) || 0) - (figMentions.get(a.fig_id) || 0));
  // Prüfwort: Beruf, sonst der Name einer anderen Figur aus der Referenz
  // (Familie), sonst ein Inhaltswort der Beschreibung.
  const otherNameIn = (f, text) => figRows.find(g => g.fig_id !== f.fig_id && !f.name.includes(g.name)
    && g.name.length >= 4 && text.includes(g.name))?.name;
  topFigs.slice(0, PER_CAT).forEach((f, i) => {
    const card = cardById.get('fig:' + f.fig_id + ':core');
    const other = otherNameIn(f, card.statement);
    const must = card.fields.beruf ? [String(card.fields.beruf).split(/[\s,]+/)[0]]
      : other ? [other] : keyTerms(card.fields.beschreibung || card.statement, 1, f.name);
    add('figure', fill(Q[lang].figure[i % 3], { n: f.name }), { expected: card.statement, mustContain: must });
  });

  // ── Beziehungen: Kernbeziehungen mit Rollenwort ───────────────────────
  const rels = relationFacts.filter(r => r.core && roleNoun(r.typ, genderOf(r.b), langIsEn));
  rels.slice(0, PER_CAT).forEach((r, i) => {
    const flip = i % 2 === 1;
    const X = flip ? r.b : r.a, Y = flip ? r.a : r.b;
    const typY = flip ? inverseTyp(r.typ) : r.typ;
    const role = roleNoun(typY, genderOf(Y), langIsEn);
    if (!role) return;
    const expected = relationAnswers({ X, Y, typY, desc: '', descFromX: false }, langIsEn)[1] || '';
    add('relation', fill(Q[lang].relation[i % 3], { x: X.name, y: Y.name }), {
      expected, mustContain: [role.noun], holdout: valUnits.has('rel:' + r.key) });
  });

  // ── Kapitel: Inhalt aus den Ereignissen ───────────────────────────────
  const chCards = factCards.filter(c => c.kind === 'chapter');
  chCards.slice(0, PER_CAT).forEach((c, i) => {
    const firstEv = (c.fields.ereignisse || [])[0] || '';
    const names = figRows.filter(f => nameRegex(f.name).test(firstEv)).map(f => f.name).slice(0, 2);
    add('chapter', fill(Q[lang].chapter[i % 3], { k: c.subject }), {
      expected: c.statement,
      mustContain: names.length ? names : keyTerms(firstEv, 1),
      holdout: valUnits.has('chap:' + c.subject),
    });
  });

  // ── Fortsetzung: Abschnittsanfang, bevorzugt aus dem Holdout ──────────
  const isVal = (p) => valPages.has('p:' + p.id);
  // Anfang = erster Absatz bzw. (bei Abschnitten ohne Leerzeilen) die
  // ersten Sätze bis 800 Zeichen; Referenz = was danach im Buch steht.
  const opener = (p) => clipAtSentence(splitParagraphs(p.text || '')[0] || '', 800);
  const withText = pageContents.filter(p => opener(p).length >= 120 && (p.text || '').length >= opener(p).length + 200);
  const valP = withText.filter(isVal);
  const contPages = [...valP, ...withText.filter(p => !isVal(p))].slice(0, PER_CAT);
  for (const p of contPages) {
    const opening = opener(p);
    const expected = clipAtSentence(p.text.slice(p.text.indexOf(opening) + opening.length).trim(), 600);
    const names = figRows.filter(f => nameRegex(f.name).test(expected)).map(f => f.name).slice(0, 2);
    add('continuation', Q[lang].continuation + opening, { expected, mustContain: names.length ? names : keyTerms(expected, 1), holdout: isVal(p) });
  }

  // ── Neues Kapitel: zwei verbundene Figuren ────────────────────────────
  const pairs = rels.length ? rels.map(r => [r.a, r.b]) : (topFigs.length >= 2 ? [[topFigs[0], topFigs[1]]] : []);
  const paras = pageContents.flatMap(p => splitParagraphs(p.text || ''));
  // Im Text steht die Figur oft ohne Klammerzusatz («Jean Buddenbrook (Konsul)»)
  // oder unter einem der Kurznamen («Der Konsul / Jean»).
  const mentions = (f, x) => [f.name, f.name.replace(/\s*\(.*?\)\s*/g, ' ').trim(), ...String(f.kurzname || '').split('/')]
    .map(n => String(n || '').trim()).filter(n => n.length >= 3).some(n => nameRegex(n).test(x));
  pairs.slice(0, PER_CAT).forEach(([a, b]) => {
    const both = paras.find(x => mentions(a, x) && mentions(b, x))
      || paras.find(x => x.length >= 200 && mentions(a, x))
      || paras.find(x => x.length >= 200) || '';
    add('newChapter', fill(Q[lang].newChapter, { a: a.name, b: b.name }), {
      expected: clipAtSentence(both, 600), mustContain: [a.name.split(/\s+/)[0], b.name.split(/\s+/)[0]] });
  });

  buildReaderEvalPrompts(ctx, add, { Q, fill, PER_CAT, rels });

  // Kapitel ohne Ereignisse: wenigstens die Frage (Referenz aus dem Kapiteltext).
  if (!chCards.length) {
    chapterKeys.filter(k => (chapterFullTextByKey.get(k) || '').length >= 400).slice(0, PER_CAT).forEach((k, i) => {
      const text = chapterFullTextByKey.get(k);
      const names = figRows.filter(f => nameRegex(f.name).test(text.slice(0, 3000))).map(f => f.name).slice(0, 2);
      add('chapter', fill(Q[lang].chapter[i % 3], { k: chapterNameByKey.get(k) }), {
        expected: clipAtSentence(text, 600), mustContain: names });
    });
  }
  return out;
}

module.exports = { buildEvalPrompts, EVAL_QUESTIONS: Q };

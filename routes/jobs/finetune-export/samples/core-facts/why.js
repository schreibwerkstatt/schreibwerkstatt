'use strict';

// Warum-Familie (docs/finetuning.md#warum-familie): «Warum vergewaltigt Stefan
// Renate am Chilbi-Abend?», «Was steckt hinter «…»?». Die Antwort erklärt
// DIESES Ereignis aus Daten der Analyse (Bausteine: why-parts.js):
//   1. die Bedeutung des Ereignisses, in mehreren Rahmungen, ein führendes
//      «Er»/«Sie» durch den Namen ersetzt;
//   2. die Lage der Figur zu diesem Zeitpunkt (Alter, Schauplatz, Ehe);
//   3. die Vorgeschichte: frühere persönliche Ereignisse derselben Figur, die
//      mit diesem zu tun haben — nie ein späteres, nie Weltgeschehen;
//   4. höchstens ein Teilsatz aus Motivation/Konflikt, nur wenn er
//      nachweislich zum Ereignis passt, umgestellt statt wörtlich.
// Je Frage eine eigene Antwortfassung: dieselbe Antwort auf viele Fragen hätte
// das Modell als Profilblock gelernt, den es auf jede Warum-Frage legt.
//
// Handelnd ist die Figur, deren Name den Ereignistitel eröffnet; steht ein
// Handlungsverb dahinter, wird daraus die Verbfrage («Warum vergewaltigt
// Stefan Renate …?»). Jede weitere beteiligte Figur bekommt eine eigene Karte
// aus ihrer Sicht («Wie erlebt Renate «…»?»), wenn die Bedeutung sie nicht
// als «Er»/«Sie» der handelnden Figur meint oder ein Teilsatz ihres Profils
// zum Ereignis passt. Die Ereignisfragen («Wie kam es zu «…»?») trägt die
// Karte der handelnden Figur, sonst die der Figur, die der Titel nennt, sonst
// die der einzigen Beteiligten. Keine Warum-Karte ohne Bedeutung, für
// Weltgeschehen, Geburt und Tod.
//
// Eine Karte je Ereignis und Figur (`evt:<i>:motive[:<fig>]`), Einheit
// `evt:<i>`. Kernwissen (`core`, immer im Train), wenn die Figur eine
// Hauptfigur ist; geschützt ist nur die erste Fassung (lib/token-mix.js).
// Die übrigen Fassungen liegen in `ctx.whyAnswers` — die KI-Leserfragen
// (ai-paraphrase.js#buildAiWhyQuestions) nehmen von dort, was die Vorlagen
// nicht belegt haben.

const { nameRegex } = require('../../lib/names');
const { bestTier } = require('./relations');
const { declineName, isRoleName } = require('./naming');
const { genitive } = require('./words');
const { joinList } = require('./events');
const {
  isPersonal, bedeutungFor, meaningFrames, situation, precedingEvents, precedingSentences,
  profileClause, profileFrames, composeAnswers,
} = require('./why-parts');

// Zustand statt Handlung: dafür gibt es kein Warum aus der Motivation.
const STATE_VERBS = new Set(['ist', 'wird', 'war', 'wurde', 'hat', 'hatte', 'bleibt', 'liegt', 'gilt', 'heisst', 'heißt',
  'is', 'was', 'has', 'had', 'becomes', 'remains', 'gets']);

// Fragen je Karte aus den Vorlagen; die übrigen Fassungen bleiben den KI-Fragen.
const TEMPLATE_QUESTIONS = 5;
const AI_RESERVE = 3;

const Q = {
  de: {
    verb: ['Warum {v} {X} {rest}?', 'Wieso {v} {X} {rest}?'],
    actor: [
      'Was treibt {X:akk} bei «{e}» an?',
      'Was sind {Xg} Beweggründe bei «{e}»?',
      'Wie ist {Xg} Handeln bei «{e}» zu verstehen?',
    ],
    other: [
      'Wie erlebt {X} «{e}»?',
      'Was bedeutet «{e}» für {X:akk}?',
      'Was geht in {X:dat} vor, als es zu «{e}» kommt?',
      'Wie geht es {X:dat} mit «{e}»?',
    ],
    event: [
      'Wie kommt es zu «{e}»?',
      'Was steckt hinter «{e}»?',
      'Was führt zu «{e}»?',
    ],
  },
  en: {
    verb: [],
    actor: [
      'What drives {X} in «{e}»?',
      "What are {Xg} motives in «{e}»?",
      "How should we understand {Xg} actions in «{e}»?",
    ],
    other: [
      'How does {X} experience «{e}»?',
      'What does «{e}» mean for {X}?',
      'What is going on inside {X} when «{e}» happens?',
    ],
    event: [
      'How does it come to «{e}»?',
      'What lies behind «{e}»?',
      'What leads to «{e}»?',
    ],
  },
};

const CONJ = new Set(['und', 'and', 'mit', 'with', 'sowie', 'or', 'oder']);
const usableFig = (f, figNameInfo) => f.fig_id && !isRoleName(f.name) && !figNameInfo?.get(f.fig_id)?.ambiguous;

// Name als Satzsubjekt am Titelanfang → { fig, form, verb, rest }. `verb`
// nur, wenn das zweite Wort klein beginnt und kein Zustandsverb oder keine
// Konjunktion ist («Fabio und Sarah werden …» → Handelnder ohne Verbfrage).
// null bei Zustand («Peter ist Mitglied …»).
function actorOf(e, figNameInfo) {
  const title = String(e.ereignis || '').split(';')[0].trim();
  for (const f of e.figs) {
    if (!usableFig(f, figNameInfo)) continue;
    const forms = [...new Set([...(f.names || [f.name]), String(f.name).split(/\s+/)[0]])]
      .filter(n => n && n.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const form of forms) {
      if (!title.startsWith(form + ' ')) continue;
      const tail = title.slice(form.length + 1).trim();
      const m = tail.match(/^(\p{Ll}\S*)\s+(.+)$/u);
      if (m && CONJ.has(m[1].toLowerCase())) return { fig: f, form, verb: null, rest: null, title };
      if (!m || STATE_VERBS.has(m[1].toLowerCase())) return null;
      return { fig: f, form, verb: m[1], rest: m[2].replace(/[.!?]+$/, ''), title };
    }
  }
  return null;
}

// Antwortfassungen einer Karte (Figur `fig` mit Anzeigename `X`). `bed`: die
// Bedeutung, '' wenn sie aus Sicht dieser Figur nicht passt.
function whyAnswers(ctx, fig, e, X, bed) {
  const { langIsEn } = ctx;
  const prev = precedingEvents(ctx, fig, e);
  return {
    prev,
    answers: composeAnswers({
      meaning: meaningFrames(bed, X, e.ereignis, langIsEn),
      sit: situation(ctx, fig, e, X),
      prev: precedingSentences(prev, X, langIsEn, joinList),
      prof: profileFrames(profileClause(fig, e, X, langIsEn), X, langIsEn),
    }),
  };
}

function buildEventWhy(ctx, emitCard) {
  const { langIsEn, events = [], figRows = [] } = ctx;
  const L = Q[langIsEn ? 'en' : 'de'];
  const figById = new Map(figRows.map(f => [f.fig_id, f]));
  ctx.whyAnswers = ctx.whyAnswers || new Map();
  let built = 0;
  const plain = (name) => String(name).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  for (const e of events) {
    if (!isPersonal(e) || !String(e.bedeutung || '').trim()) continue;
    const act = actorOf(e, ctx.figNameInfo);
    const cands = e.figs.filter(f => usableFig(f, ctx.figNameInfo) && figById.has(f.fig_id))
      .sort((a, b) => (act && b.fig_id === act.fig.fig_id ? 1 : 0) - (act && a.fig_id === act.fig.fig_id ? 1 : 0));
    const titleFig = act ? act.fig
      : cands.find(f => (f.names || [f.name]).concat(String(f.name).split(/\s+/)[0]).some(n => n && n.length >= 3 && nameRegex(n).test(e.ereignis)))
        || (e.figs.length === 1 ? cands[0] : null);
    for (const f of cands.slice(0, 3)) {
      const fig = figById.get(f.fig_id);
      const primary = !!act && f.fig_id === act.fig.fig_id;
      const X = primary ? act.form : plain(f.name);
      // Ein führendes «Er»/«Sie» der Bedeutung meint die handelnde Figur; aus
      // Sicht einer anderen Figur bleibt die Bedeutung dann weg.
      const rawBed = String(e.bedeutung || '').trim();
      const leadsWithPronoun = /^(Er|Sie|He|She)\s/.test(rawBed);
      const bed = primary || !leadsWithPronoun ? bedeutungFor(rawBed, X, langIsEn) : '';
      if (!bed && (primary || !profileClause(fig, e, X, langIsEn))) continue;
      const { prev, answers } = whyAnswers(ctx, fig, e, X, bed);
      if (!answers.length) continue;

      const Xg = genitive(X, langIsEn);
      const fill = (t) => {
        let q = t.replace(/\{e\}/g, e.ereignis).replace(/\{v\}/g, act?.verb || '').replace(/\{rest\}/g, act?.rest || '');
        if (q.includes('{Xg}')) { if (!Xg) return null; q = q.replace(/\{Xg\}/g, Xg); }
        q = q.replace(/\{X:(akk|dat)\}/g, (_, k) => (langIsEn ? X : declineName(X, k) || X));
        return q.replace(/\{X\}/g, X);
      };
      const questions = [
        ...(primary && act.verb ? L.verb : []),
        ...(primary ? L.actor : L.other),
        ...(titleFig && f.fig_id === titleFig.fig_id ? L.event : []),
      ].map(fill).filter(Boolean);
      // Je Frage eine eigene Fassung: nie mehr Fragen als Fassungen. Mit
      // KI-Leserfragen (`aiWhyQuestions`) bleibt ein Teil der Fassungen für sie
      // frei — sie fragen so, wie Leser fragen.
      const reserve = ctx.opts?.aiWhyQuestions === false ? 0 : Math.min(AI_RESERVE, Math.floor(answers.length / 2));
      const n = Math.min(TEMPLATE_QUESTIONS, questions.length, Math.max(1, answers.length - reserve));
      const id = primary ? `evt:${e.i}:motive` : `evt:${e.i}:motive:${f.fig_id}`;
      const tier = bestTier(ctx, [f]);
      const emitted = emitCard({
        id, kind: 'event', unit: 'evt:' + e.i, tier,
        ...(tier === 'main' ? { core: true } : {}),
        subject: e.ereignis,
        fields: { figur: fig.name, bedeutung: e.bedeutung || '', vorgeschichte: prev.map(p => p.ereignis) },
      }, { task: 'eventWhy', questions, answers, count: n, distinct: true });
      if (emitted) {
        built++;
        ctx.whyAnswers.set(id, answers);
      }
    }
  }
  ctx.eventWhyCount = built;
  return built;
}

module.exports = { buildEventWhy, actorOf, whyAnswers };

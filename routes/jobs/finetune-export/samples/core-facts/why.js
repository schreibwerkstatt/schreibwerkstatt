'use strict';

// Warum-Familie (docs/finetuning.md#warum-familie): «Warum vergewaltigt Stefan
// Renate am Chilbi-Abend?», «Was steckt hinter «…»?». Die Antwort setzt sich
// aus Daten zusammen, die schon in der Analyse stehen — nichts wird erfunden:
//   1. die Bedeutung des Ereignisses (`bedeutung`), ein führendes «Er»/«Sie»
//      durch den Namen der handelnden Figur ersetzt;
//   2. die ein, zwei Sätze aus Motivation und Konflikt der handelnden Figur,
//      die am meisten mit dem Ereignis zu tun haben (Stichwörter aus Titel und
//      Bedeutung, Namen der übrigen Beteiligten);
//   3. die Vorgeschichte: die letzten zwei persönlichen Ereignisse derselben
//      Figur davor im Zeitstrahl — ohne Weltgeschehen und ohne Geburt/Tod
//      (der Sonnentempler-Selbstmord ist keine Vorgeschichte einer Tat).
// Handelnd ist die Figur, deren Name den Ereignistitel eröffnet; steht ein
// Handlungsverb dahinter, wird daraus die Verbfrage («Warum vergewaltigt
// Stefan Renate …?»). Jede weitere beteiligte Figur bekommt eine eigene Karte
// aus ihrer Sicht («Wie erlebt Renate «…»?»), aber nur, wenn ein Satz ihrer
// Motivation oder ihres Konflikts nachweislich zum Ereignis passt — ihr
// allgemeiner Antrieb ist keine Antwort auf ein bestimmtes Ereignis. Die
// Ereignisfragen («Wie kam es zu «…»?») trägt die Karte der handelnden Figur,
// sonst die der Figur, die der Titel nennt («Stefans Rekrutenschule»), sonst
// die der einzigen beteiligten Figur — nie die einer Nebenperson.
// Keine Warum-Karte ohne Bedeutung, für Weltgeschehen, Geburt und Tod — «Warum
// wird Erika geboren?» ist keine Leserfrage, und «Warum ist «E» wichtig?»
// beantwortet schon die Bedeutungskarte (events.js).
// Analyse-Etiketten («(Want)», «Need:») fallen aus den Motivsätzen; ein Satz
// ohne Subjekt («Will eine Heirat eingehen.») bekommt den Namen davor.
//
// Eine Karte je Ereignis (`evt:<i>:motive`), viele Fragen, mehrere
// Antwortfassungen (Reihenfolge der Bausteine). Einheit `evt:<i>` wie alle
// Ereignis-Samples. Kernwissen (`core`), wenn die handelnde Figur eine
// Hauptfigur ist.

const { nameRegex } = require('../../lib/names');
const { splitSentences } = require('../../lib/text');
const { bestTier } = require('./relations');
const { declineName, isRoleName } = require('./naming');
const { genitive } = require('./words');
const { joinList } = require('./events');

const STOP = new Set(['und', 'oder', 'aber', 'nicht', 'einer', 'einem', 'einen', 'eines', 'seine', 'seiner',
  'seinen', 'ihrer', 'ihren', 'their', 'there', 'which', 'about', 'after', 'before', 'durch', 'gegen', 'zwischen']);
const stemsOf = (text) => [...new Set(
  String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 5 && !STOP.has(w)).map(w => w.slice(0, 6))
)];

// Zustand statt Handlung: dafür gibt es kein Warum aus der Motivation.
const STATE_VERBS = new Set(['ist', 'wird', 'war', 'wurde', 'hat', 'hatte', 'bleibt', 'liegt', 'gilt', 'heisst', 'heißt',
  'is', 'was', 'has', 'had', 'becomes', 'remains', 'gets']);
const NO_WHY_SUBTYPES = new Set(['geburt', 'tod']);
const isPersonal = (e) => String(e.typ || '').toLowerCase() !== 'extern'
  && !String(e.subtyp || '').toLowerCase().startsWith('extern')
  && !NO_WHY_SUBTYPES.has(String(e.subtyp || '').toLowerCase());
// Analyse-Sprache über den Text, nicht über die Figur — keine Antwort.
const META_LEAD = /^(Zeigt|Verdeutlicht|Illustriert|Unterstreicht|Etabliert|Charakterisiert|Shows|Illustrates|Underlines|Establishes)\b/;
const LABEL_TAG = /\s*\((Want|Need|Wound|Lie|Ghost|Ziel|Bedürfnis|Wunde|Lüge)\)/gi;
const LABEL_LEAD = /^(Want|Need|Wound|Lie|Ghost|Ziel|Bedürfnis|Wunde|Lüge)\s*:\s*/i;
const VERB_LEAD = /^(Will|Möchte|Wünscht|Sucht|Strebt|Hofft|Fürchtet|Kämpft|Ringt|Versucht|Braucht|Liebt|Hasst|Fühlt|Lebt|Muss|Kann|Hat|Ist|Steht|Wants|Needs|Seeks|Hopes|Fears|Struggles|Tries|Feels|Lives|Has|Is)\s/;

function cleanMotive(s, name) {
  let t = String(s || '').replace(LABEL_TAG, '').replace(LABEL_LEAD, '').trim();
  if (VERB_LEAD.test(t)) t = name + ' ' + t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}

const Q = {
  de: {
    verb: ['Warum {v} {X} {rest}?', 'Wieso {v} {X} {rest}?', 'Weshalb {v} {X} {rest}?'],
    actor: [
      'Was treibt {X:akk} bei «{e}» an?',
      'Was sind {Xg} Beweggründe bei «{e}»?',
      'Wie ist {Xg} Handeln bei «{e}» zu verstehen?',
      'Was geht in {X:dat} vor, als es zu «{e}» kommt?',
    ],
    other: [
      'Wie erlebt {X} «{e}»?',
      'Was bedeutet «{e}» für {X:akk}?',
      'Was geht in {X:dat} vor, als es zu «{e}» kommt?',
      'Wie geht es {X:dat} mit «{e}»?',
    ],
    event: [
      'Warum kommt es zu «{e}»?',
      'Wie kommt es zu «{e}»?',
      'Was steckt hinter «{e}»?',
      'Was führt zu «{e}»?',
      'Wie konnte es zu «{e}» kommen?',
    ],
    before: (list, n) => `Vorausgegangen ${n > 1 ? 'sind' : 'ist'} ${list}.`,
    beforeAlt: (x, list) => `Davor erlebt ${x} ${list}.`,
  },
  en: {
    verb: [],
    actor: [
      'What drives {X} in «{e}»?',
      "What are {Xg} motives in «{e}»?",
      "How should we understand {Xg} actions in «{e}»?",
      'What is going on inside {X} when «{e}» happens?',
    ],
    other: [
      'How does {X} experience «{e}»?',
      'What does «{e}» mean for {X}?',
      'What is going on inside {X} when «{e}» happens?',
    ],
    event: [
      'Why does «{e}» happen?',
      'How does it come to «{e}»?',
      'What lies behind «{e}»?',
      'What leads to «{e}»?',
      'How could «{e}» happen?',
    ],
    before: (list) => `It is preceded by ${list}.`,
    beforeAlt: (x, list) => `Before that, ${x} goes through ${list}.`,
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

// «Er entdeckt …» → «Stefan entdeckt …», sonst unverändert.
function bedeutungFor(bed, name, langIsEn) {
  const t = String(bed || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const re = langIsEn ? /^(He|She)\s/ : /^(Er|Sie)\s/;
  if (META_LEAD.test(t)) return '';
  const out = re.test(t) ? t.replace(re, name + ' ') : t;
  return /[.!?]$/.test(out) ? out : out + '.';
}

// Die Sätze aus Motivation und Konflikt, die dem Ereignis am nächsten sind.
// `strict`: nur passende Sätze, kein Auffüllen — für Figuren, die das Ereignis
// nicht selbst auslösen.
function motiveSentences(fig, e, max = 2, { strict = false } = {}) {
  const pool = [fig.motivation, fig.konflikt]
    .flatMap(t => splitSentences(String(t || '').trim()))
    .map(s => s.trim())
    .filter(s => s.length >= 25 && /[.!?]$/.test(s)
      && (s.match(/«/g) || []).length === (s.match(/»/g) || []).length);
  if (!pool.length) return [];
  const stems = stemsOf(e.ereignis + ' ' + (e.bedeutung || ''));
  const others = e.figs.filter(f => f.fig_id !== fig.fig_id).flatMap(f => f.names || [f.name]);
  const scored = pool.map((s, idx) => {
    const low = s.toLowerCase();
    const score = stems.filter(st => low.includes(st)).length
      + 2 * others.filter(n => nameRegex(n).test(s)).length;
    return { s, idx, score };
  });
  const pick = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, max);
  // Der erste Satz der Motivation trägt das Wesentliche; er füllt auf, wenn
  // weniger als `max` Sätze zum Ereignis passen.
  if (strict && !pick.length) return [];
  if (pick.length < max && !pick.some(x => x.idx === 0)) pick.push(scored[0]);
  return pick.sort((a, b) => a.idx - b.idx).map(x => x.s);
}

function buildEventWhy(ctx, emitCard) {
  const { langIsEn, events = [], figRows = [] } = ctx;
  const L = Q[langIsEn ? 'en' : 'de'];
  const figById = new Map(figRows.map(f => [f.fig_id, f]));
  const byFig = new Map();
  for (const e of events) {
    for (const f of e.figs) {
      if (!f.fig_id) continue;
      if (!byFig.has(f.fig_id)) byFig.set(f.fig_id, []);
      byFig.get(f.fig_id).push(e);
    }
  }
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
      const motives = motiveSentences(fig, e, 2, { strict: !primary })
        .map(m => bedeutungFor(cleanMotive(m, X), X, langIsEn)).filter(Boolean);
      if (!motives.length) continue;
      // Ein führendes «Er»/«Sie» der Bedeutung meint die handelnde Figur; aus
      // Sicht einer anderen Figur bleibt die Bedeutung dann weg.
      const rawBed = String(e.bedeutung || '').trim();
      const bed = primary || !/^(Er|Sie|He|She)\s/.test(rawBed) ? bedeutungFor(rawBed, X, langIsEn) : '';
      if (primary && !bed) continue;
      const prev = (byFig.get(fig.fig_id) || []).filter(p => p.i < e.i && isPersonal(p)).slice(-2).map(p => '«' + p.ereignis + '»');
      const prevList = prev.length ? joinList(prev, langIsEn) : '';
      const before = prevList ? L.before(prevList, prev.length) : '';
      const beforeAlt = prevList ? L.beforeAlt(X, prevList) : '';
      const M = motives.join(' ');

      const answers = [
        [bed, M, before],
        [M, bed, beforeAlt],
        [bed, beforeAlt, M],
        [M, before, bed],
      ].map(parts => parts.filter(Boolean).join(' ')).filter(a => a.length >= 40);

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

      const tier = bestTier(ctx, [f]);
      const n = emitCard({
        id: primary ? `evt:${e.i}:motive` : `evt:${e.i}:motive:${f.fig_id}`, kind: 'event', unit: 'evt:' + e.i, tier,
        ...(tier === 'main' ? { core: true } : {}),
        subject: e.ereignis,
        fields: { figur: fig.name, bedeutung: e.bedeutung || '', motive: motives, vorgeschichte: prev },
      }, { task: 'eventWhy', questions, answers, count: questions.length });
      if (n) built++;
    }
  }
  ctx.eventWhyCount = built;
  return built;
}

module.exports = { buildEventWhy, actorOf, motiveSentences, bedeutungFor, cleanMotive };

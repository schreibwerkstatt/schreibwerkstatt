'use strict';

// Bausteine der Warum-Antworten (why.js: Ereignis, scene-why.js: Szene). Eine
// Antwort erklärt DIESES Ereignis, nicht die Figur im Allgemeinen:
//   - die Bedeutung des Ereignisses in mehreren Rahmungen (`meaningFrames`);
//   - die Lage der Figur zu diesem Zeitpunkt (`situation`): Alter, Schauplatz,
//     Ehe — nur aus sicheren Jahren;
//   - die Vorgeschichte (`preceding`): nur Ereignisse, die zeitlich VOR dem
//     gefragten liegen und mit ihm zu tun haben (dieselbe Figur und eine weitere
//     gemeinsame Figur, derselbe Handlungsstrang oder derselbe Abschnitt);
//   - höchstens EIN Teilsatz aus dem Profil (`profileClause`), und nur, wenn er
//     nachweislich zum Ereignis passt — umgestellt und gerahmt, nie der
//     Profilsatz selbst. Der erste Satz der Motivation als Lückenfüller stand
//     sonst in jeder Antwort der Figur, und das Modell lernte ihn als Antwort
//     auf jede Warum-Frage, auch zu anderen Figuren.

const { nameRegex } = require('../../lib/names');
const { splitSentences } = require('../../lib/text');
const { declineName } = require('./naming');
const { genitive, ownBirthYear } = require('./words');

const STOP = new Set(['und', 'oder', 'aber', 'nicht', 'einer', 'einem', 'einen', 'eines', 'seine', 'seiner',
  'seinen', 'ihrer', 'ihren', 'their', 'there', 'which', 'about', 'after', 'before', 'durch', 'gegen', 'zwischen']);
const stemsOf = (text) => [...new Set(
  String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 5 && !STOP.has(w)).map(w => w.slice(0, 6))
)];

const NO_WHY_SUBTYPES = new Set(['geburt', 'tod']);
const isPersonal = (e) => String(e.typ || '').toLowerCase() !== 'extern'
  && !String(e.subtyp || '').toLowerCase().startsWith('extern')
  && !NO_WHY_SUBTYPES.has(String(e.subtyp || '').toLowerCase());

// Analyse-Sprache über den Text, nicht über die Figur — keine Antwort.
const META_LEAD = /^(Zeigt|Verdeutlicht|Illustriert|Unterstreicht|Etabliert|Charakterisiert|Shows|Illustrates|Underlines|Establishes)\b/;
const LABEL_TAG = /\s*\((Want|Need|Wound|Lie|Ghost|Ziel|Bedürfnis|Wunde|Lüge)\)/gi;
const LABEL_LEAD = /^(Want|Need|Wound|Lie|Ghost|Ziel|Bedürfnis|Wunde|Lüge)\s*:\s*/i;
// «Äusserlich …», «Innerlich …»: die Seite des Profils, nicht Teil der Aussage.
const SIDE_LEAD = /^(Äusserlich|Äußerlich|Innerlich|Nach aussen|Nach innen|Outwardly|Inwardly|Internally|Externally),?\s+/i;
const PRONOUN_LEAD = { de: /^(er|sie)\s/i, en: /^(he|she)\s/i };

const endDot = (s) => (/[.!?]»?$/.test(s) ? s : s + '.');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// «Er entdeckt …» → «Stefan entdeckt …»; '' bei Analyse-Sprache.
function bedeutungFor(bed, name, langIsEn) {
  const t = String(bed || '').trim().replace(/\s+/g, ' ');
  if (!t || META_LEAD.test(t)) return '';
  const re = langIsEn ? /^(He|She)\s/ : /^(Er|Sie)\s/;
  return endDot(re.test(t) ? t.replace(re, name + ' ') : t);
}

// Bedeutung in mehreren Rahmungen: jede Antwort der Karte ein eigener Satz,
// damit kein langer Satz dutzendfach wörtlich im Set steht.
function meaningFrames(bed, X, E, langIsEn) {
  if (!bed) return [];
  const akk = langIsEn ? X : declineName(X, 'akk') || X;
  return langIsEn
    ? [bed, `What «${E}» means for ${X}: ${bed}`, `For ${X}, «${E}» stands for this: ${bed}`, `The core of «${E}»: ${bed}`]
    : [bed, `Was «${E}» für ${akk} bedeutet: ${bed}`, `Für ${akk} steht «${E}» für Folgendes: ${bed}`, `Der Kern von «${E}»: ${bed}`];
}

// Alter, Schauplatz und Ehe der Figur zum Zeitpunkt des Ereignisses — nur aus
// sicheren Jahren. → Liste von Sätzen in zwei Fassungen, [] ohne Angabe.
function situation(ctx, fig, e, X) {
  const { langIsEn } = ctx;
  if (!e.year || e.unsure) return [];
  const born = ownBirthYear(fig, ctx.eventsByFigPk);
  const age = born && e.year - born >= 1 && e.year - born < 100 ? e.year - born : null;
  const loc = (e.locs || [])[0]?.name || '';
  const spouse = spouseAt(ctx, fig, e);
  if (!age && !loc && !spouse) return [];
  if (langIsEn) {
    const bits = [age ? `${X} is ${age} years old` : '', spouse ? `married to ${spouse}` : ''].filter(Boolean).join(' and ');
    return [
      endDot(`This happens in ${e.year}${loc ? ` at ${loc}` : ''}${bits ? `; ${bits}` : ''}`),
      endDot(`At that time${bits ? `, ${bits}` : ` (${e.year})`}${loc ? `, and the story is set at ${loc}` : ''}`),
    ];
  }
  const desc = [age ? `${age} Jahre alt` : '', spouse ? `mit ${spouse} verheiratet` : ''].filter(Boolean).join(' und ');
  const at = loc ? ` am Schauplatz «${loc}»` : '';
  return [
    endDot(`Das geschieht ${e.year}${at}${desc ? `; damals ist ${X} ${desc}` : ''}`),
    endDot(desc ? `Zu diesem Zeitpunkt (${e.year}) ist ${X} ${desc}${loc ? `, die Szene spielt am Schauplatz «${loc}»` : ''}`
      : `Zu diesem Zeitpunkt (${e.year}) ist ${X}${at}`),
  ];
}

// Ehepartner zum Zeitpunkt: eine Ehe laut den geprüften Beziehungen, deren
// Hochzeit (beide beteiligt, sicheres Jahr) davor liegt, ohne Trennung der
// beiden dazwischen. Gäste einer Hochzeit sind nicht verheiratet.
function spouseAt(ctx, fig, e) {
  const spouses = (ctx.relationFacts || []).filter(r => r.typ === 'ehepartner' && (r.a.fig_id === fig.fig_id || r.b.fig_id === fig.fig_id))
    .map(r => (r.a.fig_id === fig.fig_id ? r.b : r.a));
  const own = (ctx.events || []).filter(x => x.figs.some(f => f.fig_id === fig.fig_id) && x.year && !x.unsure && x.year <= e.year && x.i !== e.i);
  const wed = own.filter(x => String(x.subtyp) === 'hochzeit' && spouses.some(p => x.figs.some(f => f.fig_id === p.fig_id))).pop();
  if (!wed) return '';
  const partner = spouses.find(p => wed.figs.some(f => f.fig_id === p.fig_id));
  if (!partner) return '';
  const split = own.some(x => String(x.subtyp) === 'trennung' && x.year >= wed.year && x.figs.some(f => f.fig_id === partner.fig_id));
  return split ? '' : partner.name;
}

// Liegt `p` zeitlich vor `e`? Nur mit Jahr bei beiden; im selben Jahr nur mit
// Monat bei beiden (gleicher Monat: Tag, sonst nicht entscheidbar). Die
// Zeitstrahl-Reihenfolge allein reicht nicht: «Frühling 1999» ohne Monat steht
// dort nach «Ende August 1999».
function isBefore(p, e) {
  if (!p.year || !e.year) return false;
  if (p.year !== e.year) return p.year < e.year;
  if (!p.month || !e.month) return false;
  if (p.month !== e.month) return p.month < e.month;
  return !!(p.day && e.day) && p.day < e.day;
}

// Bezug zum gefragten Ereignis: eine weitere gemeinsame Figur (ausser `figId`),
// derselbe Handlungsstrang oder derselbe Abschnitt.
function related(p, e, figId) {
  const others = new Set(e.figs.filter(f => f.fig_id && f.fig_id !== figId).map(f => f.fig_id));
  if (p.figs.some(f => others.has(f.fig_id))) return true;
  if (p.storyline && p.storyline === e.storyline) return true;
  return (p.pageIds || []).some(id => (e.pageIds || []).includes(id));
}

// Die (höchstens zwei) letzten persönlichen Ereignisse der Figur vor `e`, die
// mit ihm zu tun haben. Ohne Jahr am Ziel keine Vorgeschichte.
function precedingEvents(ctx, fig, e, max = 2) {
  return (ctx.events || [])
    .filter(p => p.i !== e.i && isPersonal(p) && p.figs.some(f => f.fig_id === fig.fig_id) && isBefore(p, e) && related(p, e, fig.fig_id))
    .sort((a, b) => a.year - b.year || a.i - b.i)
    .slice(-max);
}

function precedingSentences(prev, X, langIsEn, joinList) {
  if (!prev.length) return [];
  const list = joinList(prev.map(p => `«${p.ereignis}» (${p.year})`), langIsEn);
  return langIsEn
    ? [`It is preceded by ${list}.`, `Before that, ${X} goes through ${list}.`]
    : [`Vorausgegangen ${prev.length > 1 ? 'sind' : 'ist'} ${list}.`, `Davor erlebt ${X} ${list}.`];
}

// Der Teilsatz aus Motivation/Konflikt, der am meisten mit dem Ereignis zu tun
// hat (Stichwörter aus Titel und Bedeutung, Namen der übrigen Beteiligten) —
// nur mit Treffer, nie als Lückenfüller. Seite («Äusserlich …») und Etiketten
// fallen weg; «will er …» wird zu «Stefan will …». → '' ohne Treffer.
function profileClause(fig, e, X, langIsEn) {
  const stems = stemsOf(e.ereignis + ' ' + (e.bedeutung || ''));
  const others = e.figs.filter(f => f.fig_id !== fig.fig_id).flatMap(f => f.names || [f.name]);
  let best = null;
  for (const text of [fig.motivation, fig.konflikt]) {
    for (const sent of splitSentences(String(text || '').trim())) {
      for (const raw of sent.split(/;\s+/)) {
        const c = raw.replace(LABEL_TAG, '').replace(LABEL_LEAD, '').replace(SIDE_LEAD, '').trim().replace(/[.!?]+$/, '');
        if (c.length < 25 || (c.match(/«/g) || []).length !== (c.match(/»/g) || []).length) continue;
        const low = c.toLowerCase();
        const score = stems.filter(st => low.includes(st)).length + 2 * others.filter(n => nameRegex(n).test(c)).length;
        if (score > 0 && (!best || score > best.score)) best = { c, score };
      }
    }
  }
  if (!best) return '';
  return subjectFirst(best.c, X, langIsEn);
}

// Satzbau mit der Figur vorn: «will er X» → «Stefan will X», «fehlen ihm X»
// → «Stefan fehlen X», «er sucht X» → «Stefan sucht X». '' wenn der Satz kein
// Pronomen der Figur trägt (dann gehört er womöglich einer anderen Figur).
function subjectFirst(c, X, langIsEn) {
  if (langIsEn) {
    if (/^(he|she)\s/i.test(c)) return c.replace(/^(he|she)\s/i, X + ' ');
    return /^[a-z]/.test(c) ? `${X} ${c}` : '';
  }
  let m = c.match(/^(\p{Ll}+)\s+(er|sie|ihm|ihr)\s+(.+)$/u);
  if (m) return `${X} ${m[1]} ${m[3]}`;
  m = c.match(/^(er|sie)\s+(.+)$/i);
  if (m) return `${X} ${m[2]}`;
  if (nameRegex(X).test(c.split(/\s+/).slice(0, 2).join(' '))) return c;
  return '';
}

function profileFrames(clause, X, langIsEn) {
  if (!clause) return [];
  const g = genitive(X, langIsEn) || X;
  return langIsEn
    ? [`That fits a trait that runs through ${g} story: ${clause}.`, `Behind it lies what moves ${X} throughout: ${clause}.`]
    : [`Das passt zu einem Zug, der sich durch ${g} Geschichte zieht: ${clause}.`, `Dahinter steht, was ${declineName(X, 'akk') || X} immer wieder umtreibt: ${clause}.`];
}

// Antwortfassungen aus den Bausteinen: Reihenfolge und Rahmung wechseln, 2–4
// Sätze, Ziel 200–350 Zeichen (höchstens 450). Jede Fassung ein anderer Text.
const PLANS = [
  ['m0', 's0', 'v0'], ['m1', 'p0', 's1'], ['s1', 'm2', 'v1'], ['m3', 'v0', 'p1'], ['m0', 'p1', 's1'],
  ['v1', 'm1', 's0'], ['m2', 's0', 'p0'], ['s0', 'm3'], ['m1', 'v1'], ['m3', 's1', 'v0'], ['m2', 'p0'], ['m0', 's1', 'v1'],
];
function composeAnswers({ meaning = [], sit = [], prev = [], prof = [] }) {
  const parts = { m: meaning, s: sit, v: prev, p: prof };
  const pick = (k) => {
    const arr = parts[k[0]];
    return arr.length ? arr[Number(k.slice(1)) % arr.length] : '';
  };
  const out = [];
  for (const plan of PLANS) {
    const text = plan.map(pick).filter(Boolean);
    if (text.length < 2 && !(text.length === 1 && text[0].length >= 140)) continue;
    let a = '';
    for (const t of text) if ((a + ' ' + t).trim().length <= 450 || !a) a = (a + ' ' + t).trim();
    if (a.length >= 80 && !out.includes(a)) out.push(cap(a));
  }
  return out;
}

module.exports = {
  isPersonal, bedeutungFor, meaningFrames, situation, precedingEvents, precedingSentences,
  profileClause, profileFrames, composeAnswers, isBefore, stemsOf, subjectFirst, META_LEAD,
};

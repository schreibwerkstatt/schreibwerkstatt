'use strict';

// Innenleben der Hauptfiguren als Facetten (docs/finetuning.md#innenleben-der-hauptfiguren):
// Ziel, Sehnsucht, äusserer Konflikt, innerer Widerspruch, Angst, Prägung,
// Eltern, Wandel — jede Frage mit der Antwort aus IHREM Feld, nicht dem ganzen
// Profil. Quelle sind die Tiefe-Felder der Komplettanalyse (`motivation`,
// `konflikt`, `hintergrund`, `arc`, `schluesselzitate`) und die Beziehungen.
// Fehlt das Feld (keine Angst im Text, keine Eltern), gibt es die Frage nicht:
// «Welche alte Wunde …?» ohne Wunde lehrte das Modell, irgendetwas zu sagen.
//
// Gegen Vermischung der Figuren: jede Antwort nennt die Figur im ersten Satz
// («Stefan will …»), dazu Kontrastfragen zu zwei anderen Hauptfiguren
// («Was unterscheidet Stefan von Samuel in dem, was sie antreibt?»).
// Gegen den wörtlichen Profilblock: das Profil steht in mindestens sechs
// Fassungen (kurz/lang, äussere/innere Seite, mit Zitat, aus Sicht eines
// Lesers, mit Kapitelbezug), jede Frage bekommt eine eigene (`distinct`).
//
// Typ `psyche` (Familie facts), Karte `fig:<id>:psy:<facette>`, Einheit
// `fig:<id>`, Kernwissen; geschützt ist nur die erste Fassung (lib/token-mix.js).
// Die Figuren landen in `ctx.psycheFigIds`: author-chat/depth.js lässt deren
// Motivation, Konflikt, Hintergrund und Bogen weg, sonst stünde der Block dort
// wieder ganz als Antwort.

const { splitSentences } = require('../../lib/text');
const { nameRegex, escapeRe } = require('../../lib/names');
const { declineName } = require('./naming');
const { genitive, genderOf, roleNoun, inverseTyp } = require('./words');
const { arcProse } = require('../author-chat/depth');

const LABEL_LEAD = /^(Want|Need|Wound|Lie|Ghost|Ziel|Bedürfnis|Wunde|Lüge)\s*:\s*/i;
const OUTER = /^(Äusserlich|Äußerlich|Nach aussen|Outwardly|Externally)\b,?\s*/i;
const INNER = /^(Innerlich|Nach innen|Inwardly|Internally)\b,?\s*/i;
const FEAR = /\b(Angst|Ängste|ängstlich|fürchte\w*|Furcht|afraid|fear\w*)\b/i;
const PARENT_WORDS = /\b(Mutter|Vater|Vaters|Mutters|Eltern|mother|father|parents)\b/i;

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const endDot = (s) => (/[.!?]»?$/.test(s) ? s : s + '.');

// Satz mit der Figur vorn: «Äusserlich will er …» → «Stefan will …», «Er sucht
// …» → «Stefan sucht …», «Sein äusseres Ziel ist …» → «Fabios äusseres Ziel
// ist …». Ein Satz ohne Subjekt der Figur («Erstgeborener von Gisela …») → ''.
function nameFirst(sentence, X, langIsEn) {
  let t = String(sentence || '').trim().replace(LABEL_LEAD, '').replace(OUTER, '').replace(INNER, '');
  if (!t) return '';
  const g = genitive(X, langIsEn) || X;
  if (langIsEn) {
    if (/^(he|she)\s/i.test(t)) return endDot(t.replace(/^(he|she)\s/i, X + ' '));
    if (/^(his|her)\s/i.test(t)) return endDot(t.replace(/^(his|her)\s/i, g + ' '));
    return nameRegex(X).test(t.split(/\s+/).slice(0, 2).join(' ')) ? endDot(t) : '';
  }
  let m = t.match(/^(\p{Ll}+)\s+(er|sie|ihm|ihr)\s+(.+)$/u);
  if (m) return endDot(`${X} ${m[1]} ${m[3]}`);
  m = t.match(/^(Er|Sie)\s+(.+)$/);
  if (m) return endDot(`${X} ${m[2]}`);
  m = t.match(/^(Sein|Seine|Seinen|Seinem|Seiner|Ihr|Ihre|Ihren|Ihrem|Ihrer)\s+(.+)$/);
  if (m) return endDot(`${g} ${m[2]}`);
  return nameRegex(X).test(t.split(/\s+/).slice(0, 2).join(' ')) ? endDot(t) : '';
}

// Erster Teilsatz bis Doppelpunkt/Semikolon — die Kurzform eines Facettensatzes.
function shortForm(s) {
  const head = String(s || '').split(/:\s|;\s/)[0].trim().replace(/[,.]+$/, '');
  return head.length >= 25 && head.length < s.length - 5 ? endDot(head) : s;
}

const sentencesOf = (text) => splitSentences(String(text || '').trim()).map(s => s.trim()).filter(s => s.length >= 20);

// Facetten einer Figur → { ziel: [...], sehnsucht, aussen, innen, angst, praegung, eltern, wandel }.
function facetsOf(ctx, f, X) {
  const { langIsEn } = ctx;
  const out = { ziel: [], sehnsucht: [], aussen: [], innen: [], angst: [], praegung: [], eltern: [], wandel: [] };
  const add = (k, s) => { const t = nameFirst(s, X, langIsEn); if (t && !out[k].includes(t)) out[k].push(t); };
  sentencesOf(f.motivation).forEach((s, i) => {
    if (INNER.test(s) || /^Need\b/i.test(s) || /\b(sehnt|fehlen|fehlt|sucht|longs|lacks)\b/.test(s.split(/\s+/).slice(0, 4).join(' '))) add('sehnsucht', s);
    else if (i === 0 || OUTER.test(s) || /^Want\b/i.test(s)) add('ziel', s);
  });
  sentencesOf(f.konflikt).forEach(s => {
    if (INNER.test(s) || /\b(schwankt|ringt|kollidiert|kämpft mit|zerrissen|struggles with)\b/.test(s)) add('innen', s);
    else add('aussen', s);
  });
  for (const s of [...sentencesOf(f.motivation), ...sentencesOf(f.konflikt), ...sentencesOf(f.hintergrund)]) {
    if (!FEAR.test(s)) continue;
    // Der Teilsatz mit der Angst, nicht der ganze Satz.
    const part = s.split(/;\s+/).find(p => FEAR.test(p)) || s;
    const t = nameFirst(part, X, langIsEn)
      || endDot(langIsEn ? `What ${X} fears: ${part.replace(/[.]+$/, '')}` : `Was ${declineName(X, 'akk') || X} ängstigt: ${part.replace(/[.]+$/, '')}`);
    if (!out.angst.includes(t)) out.angst.push(t);
  }
  const hg = sentencesOf(f.hintergrund);
  if (hg.length) {
    const first = nameFirst(hg[0], X, langIsEn)
      || endDot(langIsEn ? `${genitive(X, true) || X} background: ${hg[0].replace(/[.]+$/, '')}` : `Zu ${genitive(X, false) || X} Herkunft: ${hg[0].replace(/[.]+$/, '')}`);
    out.praegung.push(first);
    for (const s of hg.slice(1)) { const t = nameFirst(s, X, langIsEn); if (t) out.praegung.push(t); }
  }
  // Eltern: Namen aus den (geprüften) Beziehungen, dazu die Sätze, die von
  // Mutter, Vater oder Eltern sprechen.
  const parents = (ctx.relationFacts || []).flatMap(r => {
    if (r.a.fig_id === f.fig_id && r.typ === 'elternteil') return [r.b];
    if (r.b.fig_id === f.fig_id && inverseTyp(r.typ) === 'elternteil') return [r.a];
    return [];
  });
  const g = genitive(X, langIsEn) || X;
  if (parents.length) {
    if (parents.length >= 2) out.eltern.push(langIsEn ? `${g} parents are ${parents[0].name} and ${parents[1].name}.` : `${g} Eltern sind ${parents[0].name} und ${parents[1].name}.`);
    else {
      const rn = roleNoun('elternteil', genderOf(parents[0]), langIsEn);
      if (rn) out.eltern.push(langIsEn ? `${g} ${rn.noun} is ${parents[0].name}.` : `${g} ${rn.noun} ist ${parents[0].name}.`);
    }
  }
  const parentNames = parents.map(p => p.name);
  for (const s of [...hg, ...sentencesOf(f.motivation), ...sentencesOf(f.konflikt)]) {
    if (!PARENT_WORDS.test(s) && !parentNames.some(n => nameRegex(n).test(s))) continue;
    const t = nameFirst(s, X, langIsEn) || (out.eltern.length ? endDot(s.replace(/^(Seine|Ihre)\s/, `${g} `)) : '');
    if (t && !out.eltern.includes(t)) out.eltern.push(t);
  }
  if (out.eltern.length < 2) out.eltern = [];
  const arc = arcProse(f);
  const arcObj = (() => { try { return typeof f.arc === 'string' ? JSON.parse(f.arc) : f.arc; } catch { return null; } })();
  if (arcObj && arcObj.anfang && arcObj.ende) {
    const start = String(arcObj.anfang).trim().replace(/[.]+$/, '');
    const end = nameFirst(String(arcObj.ende).trim(), X, langIsEn) || endDot(String(arcObj.ende).trim());
    out.wandel.push(endDot(langIsEn ? `At the start, ${X} is ${lowerFirst(start)}` : /^(Ein|Eine|Der|Die|Das)\s/.test(start) ? `Zu Beginn ist ${X} ${lowerFirst(start)}` : `${X} zu Beginn: ${start}`));
    out.wandel.push(langIsEn ? `By the end: ${end}` : `Am Schluss gilt: ${end}`);
    for (const w of (arcObj.wendepunkte || []).slice(0, 3)) out.wandel.push(endDot(String(w).trim()));
  } else if (arc) {
    const s = sentencesOf(arc);
    const t = nameFirst(s[0], X, langIsEn);
    if (t) out.wandel.push(t, ...s.slice(1, 3));
  }
  return out;
}

const QUESTIONS = {
  de: {
    ziel: ['Was will {X} erreichen?', 'Welches Ziel verfolgt {X}?', 'Worauf ist {X} aus?', 'Was strebt {X} nach aussen an?'],
    sehnsucht: ['Wonach sehnt sich {X}?', 'Was fehlt {X:dat} innerlich?', 'Was sucht {X} eigentlich?', 'Was vermisst {X} im Leben?'],
    aussen: ['Wogegen kämpft {X}?', 'Mit wem oder was gerät {X} aneinander?', 'Welche Widerstände hat {X}?'],
    innen: ['Welcher innere Widerspruch prägt {X:akk}?', 'Womit ringt {X} innerlich?', 'Was zerreisst {X:akk} innerlich?'],
    angst: ['Wovor hat {X} Angst?', 'Was fürchtet {X}?', 'Welche Angst trägt {X} mit sich?'],
    praegung: ['Was hat {X:akk} geprägt?', 'Aus welchem Umfeld kommt {X}?', 'Was hat {X:akk} in der Kindheit geformt?'],
    eltern: ['Wie ist das Verhältnis zwischen {X} und den Eltern?', 'Was für Eltern hat {X}?', 'Welche Rolle spielen die Eltern für {X:akk}?'],
    wandel: ['Wie verändert sich {X} im Lauf des Buchs?', 'Wie ist {X} am Anfang, wie am Ende?', 'Welchen Weg geht {X} durch die Geschichte?'],
    profil: ['Was geht in {X} vor?', 'Was ist {X} für ein Mensch, innerlich gesehen?', 'Wie sieht es in {X} innen aus?',
      'Was bewegt {X:akk}?', 'Erzähl mir vom Innenleben von {X:dat}.', 'Was macht {X:akk} innerlich aus?', 'Was treibt {X:akk} an?'],
    kontrast: ['Was unterscheidet {X} von {Y:dat} in dem, was sie antreibt?', 'Worin unterscheiden sich {X} und {Y} in ihren Beweggründen?'],
  },
  en: {
    ziel: ['What does {X} want to achieve?', 'What goal does {X} pursue?', 'What is {X} after?'],
    sehnsucht: ['What does {X} long for?', 'What is {X} missing inside?', 'What is {X} really looking for?'],
    aussen: ['What is {X} fighting against?', 'Who or what does {X} clash with?'],
    innen: ['What inner contradiction shapes {X}?', 'What does {X} wrestle with inside?'],
    angst: ['What is {X} afraid of?', 'What does {X} fear?'],
    praegung: ['What shaped {X}?', 'What background does {X} come from?'],
    eltern: ["What is {X}'s relationship with the parents like?", 'What kind of parents does {X} have?'],
    wandel: ['How does {X} change over the book?', 'What is {X} like at the start, and at the end?'],
    profil: ['What is going on inside {X}?', 'What kind of person is {X}, inwardly?', 'What moves {X}?', "Tell me about {X}'s inner life.", 'What drives {X}?', 'What makes {X} tick inside?'],
    kontrast: ['What separates {X} from {Y} in what drives them?', 'How do {X} and {Y} differ in their motives?'],
  },
};

const fillQ = (t, X, Y, langIsEn) => t
  .replace(/\{([XY]):(akk|dat)\}/g, (_, w, k) => { const n = w === 'X' ? X : Y; return langIsEn ? n : declineName(n, k) || n; })
  .replace(/\{X\}/g, X).replace(/\{Y\}/g, Y || '');

// Fassungen einer Facette: je Frage eine. Sätze der Facette, Kurzform, mit
// Kapitelbezug, mit Zitat.
function facetAnswers(sents, extra) {
  if (!sents.length) return [];
  const [a, b] = sents;
  const out = [
    [a, b].filter(Boolean).join(' '),
    b ? shortForm(a) + ' ' + shortForm(b) : a,
    extra.chapter ? `${a} ${extra.chapter}` : '',
    extra.quote ? `${shortForm(a)} ${extra.quote}` : '',
    sents.slice(0, 3).join(' '),
  ];
  return [...new Set(out.filter(x => x && x.length >= 30))];
}

function buildPsycheFacets(ctx, emitCard) {
  const { langIsEn, figRows = [] } = ctx;
  const Q = QUESTIONS[langIsEn ? 'en' : 'de'];
  ctx.psycheFigIds = new Set();
  const mains = figRows.filter(f => ctx.tierByFig?.get(f.fig_id) === 'main' && ctx.eligibleFigIds?.has(f.fig_id));
  const nameOf = (f) => ctx.figNameInfo?.get(f.fig_id)?.name || f.name;
  const facetsByFig = new Map();
  let built = 0;
  for (const f of mains) {
    const X = nameOf(f);
    const fc = facetsOf(ctx, f, X);
    if (!fc.ziel.length && !fc.sehnsucht.length && !fc.innen.length) continue;
    facetsByFig.set(f.fig_id, { X, fc });
    ctx.psycheFigIds.add(f.fig_id);
    const chName = (ctx.appearancesByFigPk?.get(f.pk) || [])[0];
    const quotes = (() => { try { return JSON.parse(f.schluesselzitate || '[]'); } catch { return []; } })()
      .map(z => String(z || '').trim()).filter(z => z.startsWith('«') && z.length <= 180);
    // Ein Zitat nur, wenn es ein Stichwort mit der Facette teilt — sonst
    // stünde ein beliebiger Satz der Figur neben ihrer Sehnsucht.
    const stems = (t) => String(t || '').toLowerCase().split(/[^\p{L}]+/u).filter(w => w.length >= 5).map(w => w.slice(0, 5));
    const quoteFor = (sent) => {
      const st = new Set(stems(sent));
      const z = quotes.find(q => stems(q).some(w => st.has(w)));
      return z ? (langIsEn ? `In the book it sounds like this: ${z}` : `Im Buch klingt das so: ${z}`) : '';
    };
    const extra = {
      chapter: chName ? (langIsEn ? `This shows most clearly in the chapter «${chName}».` : `Am deutlichsten zeigt sich das im Kapitel «${chName}».`) : '',
    };
    const unit = 'fig:' + f.fig_id;
    const card = (facet) => ({ id: `fig:${f.fig_id}:psy:${facet}`, kind: 'psyche', unit, core: true, tier: 'main', subject: X, fields: { facette: facet } });
    for (const facet of ['ziel', 'sehnsucht', 'aussen', 'innen', 'angst', 'praegung', 'eltern', 'wandel']) {
      const answers = facetAnswers(fc[facet], { ...extra, quote: facet === 'sehnsucht' || facet === 'innen' ? quoteFor(fc[facet].join(' ')) : '' });
      if (!answers.length) continue;
      if (emitCard(card(facet), { task: 'psyche', questions: Q[facet].map(t => fillQ(t, X, '', langIsEn)), answers, distinct: true, count: Q[facet].length })) built++;
    }
    // Profil in Fassungen: kurz, lang, äussere/innere Seite, mit Zitat, aus
    // Sicht eines Lesers, mit Kapitelbezug.
    const sf = (k) => (fc[k][0] ? shortForm(fc[k][0]) : '');
    const akk = langIsEn ? X : declineName(X, 'akk') || X;
    const profile = [
      [sf('ziel'), sf('sehnsucht')],
      [fc.ziel[0], fc.sehnsucht[0], fc.innen[0]],
      [sf('ziel'), fc.aussen[0]],
      [fc.sehnsucht[0], sf('innen')],
      [sf('sehnsucht'), quoteFor(fc.sehnsucht.join(' ') + ' ' + fc.ziel.join(' '))],
      [fc.sehnsucht[0] ? (langIsEn ? `Readers come to know ${X} like this: ${sf('sehnsucht')}` : `Wer das Buch liest, lernt ${akk} so kennen: ${sf('sehnsucht')}`) : '', sf('aussen')],
      [chName ? (langIsEn ? `${X} stands at the centre of the chapter «${chName}».` : `${X} steht vor allem im Kapitel «${chName}» im Zentrum.`) : '', sf('ziel'), sf('innen')],
    ].map(p => p.filter(Boolean).join(' ')).filter(a => a.length >= 60 && nameRegex(X).test(a.split(/[.!?]/)[0]));
    if (emitCard(card('profil'), { task: 'psyche', questions: Q.profil.map(t => fillQ(t, X, '', langIsEn)), answers: [...new Set(profile)], distinct: true, count: Q.profil.length })) built++;
  }
  // Kontraste: je Hauptfigur zu den zwei Hauptfiguren, mit denen sie am
  // meisten Ereignisse teilt — beide Kernmotive kurz nebeneinander.
  const shared = (a, b) => (ctx.events || []).filter(e => e.figs.some(x => x.fig_id === a) && e.figs.some(x => x.fig_id === b)).length;
  const kern = (fc) => shortForm(fc.ziel[0] || fc.sehnsucht[0] || fc.innen[0]);
  const done = new Set();
  for (const [id, { X, fc }] of facetsByFig) {
    const partners = [...facetsByFig.keys()].filter(o => o !== id).sort((a, b) => shared(id, b) - shared(id, a)).slice(0, 2);
    for (const o of partners) {
      const key = [id, o].sort().join('|');
      if (done.has(key)) continue;
      done.add(key);
      const { X: Y, fc: fy } = facetsByFig.get(o);
      const a = kern(fc), b = kern(fy);
      const bAgainst = langIsEn ? b.replace(new RegExp('^' + escapeRe(Y) + '\\s'), `${Y}, by contrast, `) : b.replace(new RegExp('^' + escapeRe(Y) + '\\s'), `${Y} dagegen `);
      const aAgainst = langIsEn ? a.replace(new RegExp('^' + escapeRe(X) + '\\s'), `${X}, by contrast, `) : a.replace(new RegExp('^' + escapeRe(X) + '\\s'), `${X} dagegen `);
      const qs = [...Q.kontrast.map(t => fillQ(t, X, Y, langIsEn)), ...Q.kontrast.map(t => fillQ(t, Y, X, langIsEn))];
      const answers = [`${a} ${bAgainst}`, `${b} ${aAgainst}`];
      const n = emitCard({ id: `psy:contrast:${key}`, kind: 'psyche', unit: 'fig:' + [id, o].sort()[0], core: true, tier: 'main', subject: `${X} / ${Y}`, fields: {} },
        { task: 'psyche', questions: [qs[0], qs[2]], answers, distinct: true, count: 2 });
      // Zweite Frageform mit vertauschter Reihenfolge der Antwort.
      emitCard({ id: `psy:contrast:${key}:b`, kind: 'psyche', unit: 'fig:' + [id, o].sort()[0], core: true, tier: 'main', subject: `${Y} / ${X}`, fields: {} },
        { task: 'psyche', questions: [qs[1], qs[3]], answers: [answers[0] + extra2(fc), answers[1] + extra2(fy)], distinct: true, count: 2 });
      if (n) built++;
    }
  }
  ctx.psycheFacetCount = built;
  ctx.psycheFacetsByFig = facetsByFig;
  return built;
}

// Zweiter Satz für die zweite Kontrastfassung: die innere Seite der Figur.
function extra2(fc) {
  const t = fc.innen[0] || fc.sehnsucht[0];
  return t && t !== fc.ziel[0] ? ' ' + shortForm(t) : '';
}

module.exports = { buildPsycheFacets, facetsOf, nameFirst, shortForm, QUESTIONS: QUESTIONS };

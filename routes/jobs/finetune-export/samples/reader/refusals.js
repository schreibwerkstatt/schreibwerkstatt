'use strict';

// Ablehnen lernen (Familie `refusal`, docs/finetuning.md#ablehnen):
//   - unknownEntity: erfundene Figuren, Orte und Ereignisse → «kommt in meiner
//     Geschichte nicht vor». Gefragt wird überwiegend in GENAU den Frageformen,
//     mit denen echte Figuren porträtiert werden (core-facts/figures.js
//     `PORTRAIT_QUESTIONS`) und nach Beziehungen gefragt wird
//     (core-facts/relations.js `QUESTIONS`) — Kontrastpaare: das Modell soll
//     am Namen entscheiden, nicht an der Frageform. Dazu Namen, die echten
//     ähneln (echter Vorname + fremder Nachname, fremder Vorname + echter
//     Nachname, häufige Schweizer Namen) — mit dem Hinweis auf die echte
//     Figur, damit das Modell nicht lernt, sie zu leugnen;
//   - mixedRefusal: echte und erfundene Figur in einer Frage → die echte
//     kurz einordnen, die erfundene ablehnen;
//   - offTopic: buchfremde Bitten (Schreib- und Alltagsaufträge, Wissen,
//     Rat) → freundlich ablehnen, zum Buch zurück;
//   - metaQuestion: Fragen zum Buch als Werk (Autor, Erscheinungsjahr,
//     Entstehung) → aus `book_publication`, sonst ehrlich ablehnen;
//   - falsePremise: Frage mit falscher Annahme («Warum ist Gisela Stefans
//     Schwester?») → die Annahme korrigieren, immer in voller Form.
// Der Sampler erzeugt einen Vorrat; wie viele davon ins Set kommen, regelt
// finalize.js nach Anzahl (`refusalShare`, `refusalMix`, lib/token-mix.js).
// Vorlagen und Namen: ./refusal-text.js.

const { hashSplit, nameRegex } = require('../../lib/names');
const { collectRelationFacts, QUESTIONS: REL_QUESTIONS, fillRelationQuestion } = require('../core-facts/relations');
const { PORTRAIT_QUESTIONS } = require('../core-facts/figures');
const { fillCase } = require('../core-facts/naming');
const {
  genderOf, roleNoun, inverseTyp, rolePhrase, berufHead, jobInSentence, isStatus, isSingleJob, figureTypePhrase, ownBirthYear,
} = require('../core-facts/words');
const {
  FIRST, LAST, COMMON_FIRST, COMMON_LAST, PLACE_A, PLACE_B, FAKE_EVENTS, EVAL_FAKES, REFUSAL_TEXT: T, OFF_TOPIC, META,
} = require('./refusal-text');

// Paare ohne gehäufte Namen: Runde r paart firsts[i] mit lasts[(i + r) % n].
function spreadPairs(firsts, lasts, ordered) {
  const fs = ordered(firsts, 'fn|');
  const ls = ordered(lasts, 'ln|');
  const out = [];
  const rounds = Math.min(fs.length, ls.length);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < fs.length; i++) out.push(`${fs[i]} ${ls[(i + r) % ls.length]}`);
  }
  return out;
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Ein erfundener Name darf weder als Ganzes noch mit einem seiner Wörter im Buch
// vorkommen — sonst brächte das Sample dem Modell bei, eine echte Figur zu leugnen.
function unknownNames(pool, haystackLower) {
  return pool.filter(n => !n.toLowerCase().split(/\s+/).some(w => w.length >= 4 && haystackLower.includes(w)));
}

// Haystack: Buchtext + alle Figuren- und Ortsnamen, kleingeschrieben.
function buildHaystack(ctx) {
  const { pageContents, figRows, locRows } = ctx;
  return pageContents.map(p => p.text || '').join('\n').toLowerCase()
    + '\n' + figRows.map(f => `${f.name} ${f.kurzname || ''}`).join(' ').toLowerCase()
    + '\n' + locRows.map(l => l.name).join(' ').toLowerCase();
}

// Falsche Rollen für eine Beziehung: plausibel, aber unvereinbar. Plausibel
// heisst: dieselbe Generation, wenn die falsche Rolle Geschwister oder Partner
// ist, die ältere, wenn sie Elternteil oder Mentor ist, die jüngere bei Kind
// oder Schützling (`WRONG_NEEDS`). Die Generation folgt aus dem echten Typ
// (Eltern +1, Kind −1, Geschwister/Partner 0) oder aus den Geburtsjahren;
// ist sie unbekannt, entfällt eine generationsgebundene Falschannahme. Keine
// Prämisse «Renate ist die Mutter ihres Vorgesetzten», kein «Freundin» für
// eine Ehefrau (im Deutschen mehrdeutig).
const WRONG_TYPES = {
  elternteil: ['mentor', 'vorgesetzter'], kind: ['schuetzling', 'untergebener'], geschwister: ['kollege', 'freund'],
  ehepartner: ['geschwister', 'ex_partner', 'kollege'], ex_partner: ['geschwister', 'ehepartner'],
  freund: ['feind', 'kollege'], feind: ['freund'], kollege: ['vorgesetzter', 'freund'], vorgesetzter: ['kollege'],
  untergebener: ['kollege'], mentor: ['elternteil'], schuetzling: ['kind'], rivale: ['freund'], liebesbeziehung: ['geschwister', 'kollege'],
};
const WRONG_TYP = Object.fromEntries(Object.entries(WRONG_TYPES).map(([k, v]) => [k, v[0]]));
// Generation von Y gegenüber X, die die falsche Rolle voraussetzt.
const WRONG_NEEDS = { geschwister: 0, ehepartner: 0, ex_partner: 0, elternteil: 1, mentor: 1, kind: -1, schuetzling: -1 };
const GEN_OF_TYP = { elternteil: 1, kind: -1, geschwister: 0, ehepartner: 0, ex_partner: 0, liebesbeziehung: 0 };

// Generation von Y gegenüber X: +1 älter (≥ 15 Jahre), −1 jünger, 0 gleich
// (≤ 10 Jahre), null unbekannt.
function generation(typY, yearX, yearY) {
  if (typY in GEN_OF_TYP) return GEN_OF_TYP[typY];
  if (!yearX || !yearY) return null;
  const d = yearX - yearY;
  if (d >= 15) return 1;
  if (d <= -15) return -1;
  return Math.abs(d) <= 10 ? 0 : null;
}

// Falschannahmen für «Y gegenüber X» (Rolle `typY`): [{ wrongTyp, vars }],
// `vars` mit voller Form für Frage und Richtigstellung.
function wrongPremises(X, Y, typY, years, langIsEn) {
  const right = roleNoun(typY, genderOf(Y), langIsEn);
  if (!right) return [];
  const out = [];
  for (const wrongTyp of WRONG_TYPES[typY] || []) {
    if (wrongTyp in WRONG_NEEDS && generation(typY, years[0], years[1]) !== WRONG_NEEDS[wrongTyp]) continue;
    const wrong = roleNoun(wrongTyp, genderOf(Y), langIsEn);
    if (!wrong || wrong.noun === right.noun) continue;
    out.push({ wrongTyp, vars: { y: Y.name, wrong: rolePhrase(X.name, wrong, wrongTyp, langIsEn), right: rolePhrase(X.name, right, typY, langIsEn) } });
  }
  return out;
}

const SURE_BIRTH = (ctx) => (f) => ownBirthYear(f, ctx.eventsByFigPk);

// Anteil der Formen im Vorrat unbekannter Figuren: Porträt-Fragen, Beziehungs-
// fragen, übrige.
const FORM_PORTRAIT = 0.65;
const PORTRAIT_RATIO = 0.6;
const FORM_RELATION = 0.85;
const UNKNOWN_POOL = 700;
const FP_MAIN_MAX = 3;

function buildRefusalSamples(ctx, push) {
  const { langIsEn, displayName: book, figRows, opts, eligibleFigIds } = ctx;
  const seed = opts.valSeed;
  const lang = langIsEn ? 'en' : 'de';
  const t = T[lang];
  const hay = buildHaystack(ctx);
  const h = (key) => hashSplit(key, seed);
  const pick = (arr, key) => arr[Math.floor(h(key) * arr.length)];
  const ordered = (arr, tag) => [...arr].sort((a, b) => h(tag + a) - h(tag + b));
  const decl = { gender: 'n', role: false, langIsEn };
  const portraitQ = (x, key) => fillCase(pick(PORTRAIT_QUESTIONS[lang].core, key), x, decl);
  // Nur benannte Figuren (core-facts/naming.js): keine Falschannahme über
  // «Herr Koch (Primarlehrer)» oder «Renates Vorgesetzter bei der SoBa».
  const realFigs = figRows
    .filter(f => f.name && (!eligibleFigIds || eligibleFigIds.has(f.fig_id)) && ctx.figNameInfo?.get(f.fig_id)?.proper !== false)
    .map(f => ({ ...f, name: ctx.figNameInfo?.get(f.fig_id)?.name || f.name }));
  const birthYearOf = SURE_BIRTH(ctx);
  // Zurück zum Buch über die meistgenannten Figuren — ein Ortsname («Frag
  // mich lieber nach Speisesaal») passt grammatisch selten.
  const mentions = ctx.figMentions || new Map();
  const hooks = [...realFigs].filter(f => !/[()]/.test(f.name))
    .sort((a, b) => (mentions.get(b.fig_id) || 0) - (mentions.get(a.fig_id) || 0))
    .slice(0, 8).map(f => f.name);
  const hookAt = (key) => (hooks.length ? pick(hooks, 'hook|' + key) : (langIsEn ? 'my story' : 'meine Geschichte'));
  const one = (kind, key, q, a, extra = {}) => q && a && push({ id: `refusal|${kind}|${key}`, unit: extra.unit || `ref:${kind}:${key}`, turns: [[q, a]], ...extra });
  const evalFakes = new Set(EVAL_FAKES[lang].map(n => n.toLowerCase()));

  // ── Unbekannte Figuren ──────────────────────────────────────────────
  const firsts = unknownNames(FIRST[lang], hay);
  const lasts = unknownNames(LAST[lang], hay);
  const names = spreadPairs(firsts, lasts, ordered).filter(x => !evalFakes.has(x.toLowerCase()));
  // Kontrastquote: Ablehnungen in Porträt-Form höchstens PORTRAIT_RATIO je
  // echte Porträt-Frage (core-facts/figures.js, läuft vorher) — darüber
  // weicht die Form auf Beziehungs- und übrige Fragen aus. Ähnliche und
  // häufige Namen zuerst: sie sind der schärfste Kontrast.
  const realPortraits = ctx.samples.filter(s => s.task === 'figureCore').length;
  const portraitBudget = realPortraits ? Math.round(PORTRAIT_RATIO * realPortraits) : Infinity;
  let portraitUsed = 0;
  // Ähnlich einer echten Figur: echter Vorname + fremder Nachname, fremder
  // Vorname + echter Nachname — jeweils mit Hinweis auf die echte Figur.
  const nearHint = (real, key) => fill(pick(t.nearHint, key), { real });
  for (const f of realFigs) {
    if (/[()]/.test(f.name)) continue;
    const parts = f.name.trim().split(/\s+/);
    if (lasts.length) {
      for (let v = 0; v < 2; v++) {
        const x = `${parts[0]} ${pick(lasts, `near|${f.fig_id}|${v}`)}`;
        if (x === f.name || nameRegex(x).test(hay)) continue;
        if (one('unknownNear', x, portraitQ(x, 'nearQ|' + x), fill(pick(t.figA, 'nearA|' + x), { x, book }) + nearHint(f.name, 'nearH|' + x), { form: 'portrait' })) portraitUsed++;
      }
    }
    if (parts.length >= 2 && firsts.length && /^\p{Lu}/u.test(parts[parts.length - 1])) {
      const x = `${pick(firsts, 'nearL|' + f.fig_id)} ${parts[parts.length - 1]}`;
      if (!nameRegex(x).test(hay)) {
        if (one('unknownNear', x, portraitQ(x, 'nearLQ|' + x), fill(pick(t.figA, 'nearLA|' + x), { x, book }) + nearHint(f.name, 'nearLH|' + x), { form: 'portrait' })) portraitUsed++;
      }
    }
  }
  // Häufige Namen, die im Buch nicht vorkommen.
  const common = spreadPairs(unknownNames(COMMON_FIRST[lang], hay), unknownNames(COMMON_LAST[lang], hay), ordered).slice(0, 30);
  for (const x of common) {
    if (one('unknownCommon', x, portraitQ(x, 'cmQ|' + x), fill(pick(t.figA, 'cmA|' + x), { x, book }), { form: 'portrait' })) portraitUsed++;
  }

  const pool = names.slice(0, UNKNOWN_POOL);
  for (const x of pool) {
    const r = h('ufForm|' + x);
    const figA = fill(pick(t.figA, 'ufA|' + x), { x, book });
    if ((r < FORM_PORTRAIT && portraitUsed < portraitBudget) || !realFigs.length) {
      if (one('unknownFig', x, portraitQ(x, 'ufQ|' + x), figA, { form: 'portrait' })) portraitUsed++;
    } else if (r < FORM_RELATION || (r < FORM_PORTRAIT && h('ufRe|' + x) < 0.6)) {
      const real = pick(realFigs, 'ufReal|' + x).name;
      const tpl = pick(REL_QUESTIONS[lang], 'ufRelQ|' + x);
      const [a, b] = h('ufDir|' + x) < 0.5 ? [real, x] : [x, real];
      one('unknownFig', x, fillRelationQuestion(tpl, a, b, langIsEn), fill(pick(t.figRelA, 'ufRelA|' + x), { x, real, book }), { form: 'relation' });
    } else {
      one('unknownFig', x, fill(pick(t.figQ, 'ufQo|' + x), { x }), figA);
    }
  }

  // ── Unbekannte Orte und Ereignisse ──────────────────────────────────
  const places = [];
  for (const a of PLACE_A[lang]) for (const b of PLACE_B[lang]) places.push(a + b);
  for (const x of ordered(unknownNames(places, hay), 'up|').slice(0, 60)) {
    one('unknownPlace', x, fill(pick(t.placeQ, 'upQ|' + x), { x }), fill(pick(t.placeA, 'upA|' + x), { x, book }));
  }
  const eventOk = (e) => !e.split(/\s+/).some(w => w.length >= 5 && /^\p{Lu}/u.test(w) && hay.includes(w.toLowerCase()));
  for (const x of FAKE_EVENTS[lang].filter(eventOk)) {
    one('unknownEvent', x, fill(pick(t.eventQ, 'ueQ|' + x), { x }), fill(pick(t.eventA, 'ueA|' + x), { x, X: capFirst(x), book }));
  }

  // ── Teil-Ablehnung: echte und erfundene Figur ───────────────────────
  // Die echte Figur nur kurz einordnen (höchstens elf Wörter): ein längerer
  // Satz wiederholte das Porträt aus dem Train wörtlich.
  const mixPool = names.slice(UNKNOWN_POOL, UNKNOWN_POOL + 60);
  const mixReal = realFigs.filter(f => figureTypePhrase(f.typ, genderOf(f), langIsEn));
  mixPool.forEach((x, i) => {
    if (!mixReal.length) return;
    const f = pick(mixReal, 'mxR|' + x);
    const type = figureTypePhrase(f.typ, genderOf(f), langIsEn);
    const tpl = t.mixedQ[i % t.mixedQ.length];
    const realPart = fill(pick(t.mixedReal, 'mxRA|' + x), { real: f.name, type });
    const fakeFirst = tpl.indexOf('{x}') < tpl.indexOf('{real}');
    const fakePart = fill(pick(fakeFirst ? t.mixedFakeFirst : t.mixedFake, 'mxFA|' + x), { x, book });
    one('mixed', x, fill(tpl, { real: f.name, x }), fakeFirst ? `${fakePart} ${realPart}` : `${realPart} ${fakePart}`);
  });

  // ── Off-Topic: zwei Antworten pro Frage, gleiche Einheit ────────────
  OFF_TOPIC[lang].forEach(([q, thing], i) => {
    for (let v = 0; v < 2; v++) {
      const tpl = t.offA[(i + v) % t.offA.length];
      push({
        id: `refusal|offTopic|${i}|${v}`, unit: `ref:offTopic:${i}`,
        turns: [[q, fill(tpl, { thing, Thing: capFirst(thing), book, hook: hookAt(`off|${i}|${v}`) })]],
      });
    }
  });

  // ── Fragen zum Buch als Werk ────────────────────────────────────────
  buildMetaSamples(ctx, push);

  // ── Falsche Annahme ─────────────────────────────────────────────────
  // Kernbeziehungen von Hauptfiguren: bis zu FP_MAIN_MAX Falschannahmen je
  // Beziehung (beide Richtungen, mehrere falsche Rollen); übrige Beziehungen
  // eine je Richtung. Alle Samples einer Beziehung teilen die Einheit.
  const relFacts = ctx.relationFacts || collectRelationFacts(ctx).facts;
  const isMain = (f) => ctx.tierByFig?.get(f.fig_id) === 'main';
  for (const r of relFacts) {
    const main = r.core && (isMain(r.a) || isMain(r.b));
    const dirs = [[r.a, r.b, r.typ], [r.b, r.a, inverseTyp(r.typ)]]
      .map(([X, Y, typY]) => wrongPremises(X, Y, typY, [birthYearOf(X), birthYearOf(Y)], langIsEn).map(w => ({ ...w, X })));
    const items = [];
    for (let k = 0; k < 3; k++) for (const d of dirs) if (d[k]) items.push(d[k]);
    const chosen = main ? items.slice(0, FP_MAIN_MAX) : dirs.map(d => d[0]).filter(Boolean);
    chosen.forEach((w, k) => {
      const key = `rel|${r.key}|${k}`;
      const q = pick(t.fpRelQ, 'fpQ|' + key);
      const yesNo = q === t.fpRelQ[t.fpRelQ.length - 1];
      const a = yesNo ? fill(t.fpRelYesNoA, w.vars) : fill(pick(t.fpRelA, 'fpA|' + key), w.vars);
      one('falsePremise', key, fill(q, w.vars), capFirst(a), { unit: `ref:fp:${r.key}`, factIds: ['rel:' + r.key] });
    });
  }
  // Nur echte Berufe als einzelner Begriff: «Warum arbeitet X als Schüler?»
  // wäre schief, eine Aufzählung («Bezirksschüler, Hockeyspieler, …») ebenso.
  const withJob = realFigs.map(f => ({ f, job: jobInSentence(berufHead(f.beruf)) }))
    .filter(x => x.job && !isStatus(x.job) && isSingleJob(x.job));
  for (const { f, job } of withJob) {
    const other = withJob.filter(x => x.f.fig_id !== f.fig_id && x.job.toLowerCase() !== job.toLowerCase());
    if (!other.length) continue;
    const vars = { n: f.name, right: job, wrong: pick(other, 'fpJob|' + f.fig_id).job };
    const key = `job|${f.fig_id}`;
    one('falsePremise', key, fill(pick(t.fpJobQ, 'fpJQ|' + key), vars), fill(pick(t.fpJobA, 'fpJA|' + key), vars),
      { factIds: ['fig:' + f.fig_id + ':beruf'] });
  }
  for (const f of realFigs) {
    const year = birthYearOf(f);
    if (!year) continue;
    const shift = 3 + Math.floor(h('fpY|' + f.fig_id) * 12);
    const vars = { n: f.name, right: String(year), wrong: String(year + (h('fpYs|' + f.fig_id) < 0.5 ? -shift : shift)) };
    const key = `year|${f.fig_id}`;
    one('falsePremise', key, fill(pick(t.fpYearQ, 'fpYQ|' + key), vars), fill(pick(t.fpYearA, 'fpYA|' + key), vars),
      { factIds: ['fig:' + f.fig_id + ':geburt'] });
  }
}

// Meta-Fragen: je Thema eine Einheit, Antwort aus `ctx.publication`
// (db/book-publication.js#getMeta) und der Kapitelzahl — fehlt der Wert,
// lehnt das Buch ehrlich ab, statt zu raten.
function buildMetaSamples(ctx, push) {
  const { langIsEn, displayName: book } = ctx;
  const m = META[langIsEn ? 'en' : 'de'];
  const pub = ctx.publication || {};
  const chapters = (ctx.chapterKeys || []).filter(k => k !== 0).length;
  const values = {
    book,
    author: String(pub.author_name || '').trim(),
    year: String(pub.year || '').trim(),
    publisher: String(pub.publisher || '').trim(),
    chapters: chapters >= 1 ? String(chapters) : '',
    subtitle: pub.subtitle ? ` – ${String(pub.subtitle).trim()}` : '',
  };
  const known = { author: !!values.author, year: /^\d{4}$/.test(values.year), publisher: !!values.publisher, count: !!values.chapters, title: true };
  for (const [topic, def] of Object.entries(m)) {
    const answers = known[topic] ? def.known : def.unknown;
    if (!answers) continue;
    def.q.forEach((q, i) => push({
      id: `refusal|meta|${topic}|${i}`, unit: `ref:meta:${topic}`,
      turns: [[fill(q, values), fill(answers[i % answers.length], values)]],
    }));
  }
}

module.exports = {
  buildRefusalSamples, buildMetaSamples, unknownNames, buildHaystack, spreadPairs, generation, wrongPremises,
  OFF_TOPIC, REFUSAL_TEXT: T, FIRST, LAST, PLACE_A, PLACE_B, FAKE_EVENTS, WRONG_TYP, WRONG_TYPES, WRONG_NEEDS,
};

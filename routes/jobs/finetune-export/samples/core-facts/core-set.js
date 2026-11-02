'use strict';

// Kernfakten der Hauptfiguren (docs/finetuning.md#kernfakten-der-hauptfiguren):
// ein explizites Set je Hauptfigur — Eltern, Geschwister, Partner, Kinder,
// Beruf und Werdegang, Geburtsjahr, die wichtigsten persönlichen Wendepunkte
// mit Jahr, das Kapitel, in dem die Figur im Zentrum steht, und ihr Antrieb.
// Jeder Kernfakt erscheint in vielen verschiedenen Frage-Antwort-Paaren:
// direkt, umgekehrt, eingebettet («Erzähl mir von Stefans Familie»), als
// Ja/Nein-Frage, im Mehrturn-Gespräch und als Leserfrage in Alltagssprache;
// das Porträt (figures.js) und die Falschannahme (reader/refusals.js) zählen
// mit (`factIds`). Die Antworten variieren in der Formulierung, nennen den
// Fakt aber immer gleich: gleiche Namen, gleiche Verwandtschaftswörter.
//
// Ziel je Fakt: 8 × `coreFactRepeat` Paare, begrenzt durch die Zahl
// verschiedener Fragen. Die Samples sind Kernwissen der Hauptfiguren
// (`core`, `tier: main`, `coreFact`): nie gekürzt, immer im Train, und vom
// Antwort-Budget ausgenommen — jede Antwort hier höchstens
// 2 × `coreFactRepeat` Mal, das deckelt das Modul selbst.
//
// Legt `ctx.coreFactsByFig` ab: fig_id → [{ id, label }] (Statistik
// `coreFactVariants`, lib/export-stats.js).

const { hashSplit } = require('../../lib/names');
const { whenAdverb, joinList } = require('./events');
const { declineName, capFirst } = require('./naming');
const {
  genderOf, genitive, roleNoun, inverseTyp, rolePhrase, possessive, pronoun, firstSentences,
  berufHead, jobInSentence, isStatus, figureTypePhrase, FAMILY_TYPES,
} = require('./words');
const { familyOf, familySentence, turningPoint, birthYear, careerSentences } = require('./figures');
const { eventWhen } = require('../author-chat/event-data');

const KIN = new Set([...FAMILY_TYPES, 'liebesbeziehung']);
const TURNS_MAX = 5;

const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// Vorlagen je Form. `{X}` Hauptfigur, `{Xg}` ihr Genitiv («Stefans»),
// `{Xd}`/`{Xa}` Dativ/Akkusativ, `{Y}` die andere Figur, `{R}` Rolle von Y,
// `{RY}` Rollen-Nominalphrase («Stefans Ehefrau»), `{RX}` die Gegenrolle.
const T = {
  de: {
    direct: ['Wer ist {Xg} {R}?', 'Wie heisst {Xg} {R}?', 'Weisst du, wer {Xg} {R} ist?'],
    directA: ['{Xgc} {R} ist {Y}.', '{Y} ist {Xg} {R}.', '{Xgc} {R} heisst {Y}.'],
    reverse: ['Wessen {R} ist {Y}?', '{Y} ist wessen {R}?', 'Zu wem gehört {Y} als {R}?'],
    reverseA: ['{Y} ist {RY}.', 'In meiner Geschichte ist {Y} {RY}.', '{Y} ist {RY}; {X} ist {RXp}.'],
    yes: ['Ist {Y} {RY}?', 'Stimmt es, dass {Y} {RY} ist?'],
    yesA: ['Ja, {Y} ist {RY}.', 'Ja. {Y} ist {RY}.'],
    yesX: ['Ist {X} {RX}?'],
    yesXA: ['Ja, {X} ist {RX}.'],
    married: ['Ist {X} verheiratet?', 'Mit wem ist {X} eigentlich verheiratet?', 'Hat {X} einen Partner oder eine Partnerin?'],
    marriedA: ['Ja, {X} ist mit {Y} verheiratet.', '{X} ist mit {Y} verheiratet; {Y} ist {RY}.'],
    parents: ['Wer sind {Xg} Eltern?', 'Von wem stammt {X} ab?', 'Wer hat {Xa} grossgezogen?'],
    kids: ['Hat {X} Kinder?', 'Wie heissen {Xg} Kinder?'],
    sibs: ['Hat {X} Geschwister?', 'Mit wem ist {X} aufgewachsen?'],
    family: ['Erzähl mir von {Xg} Familie.', 'Wie sieht {Xg} Familie aus?', 'Wer gehört alles zu {Xg} Familie?'],
    yesPrefix: 'Ja. ',
    turn1: ['Wer ist {X}?', 'Erzähl mir kurz von {Xd}.'],
    nextUnique: 'Und wer ist {poss} {R}?',
    nextUniqueA: '{possc} {R} ist {Y}.',
    nextAny: 'Und wie steht {pron} zu {Yd}?',
    nextAnyA: '{Y} ist {RY}.',
    job: ['Was ist {X} von Beruf?', 'Womit verdient {X} {possN} Geld?', 'Was arbeitet {X}?', 'Was hat {X} gelernt?'],
    jobYes: ['Arbeitet {X} als {J}?'],
    jobYesA: ['Ja, {X} arbeitet als {J}.'],
    statusYes: ['Ist {X} {J}?'],
    statusYesA: ['Ja, {X} ist {J}.'],
    jobNext: 'Und was macht {pron} beruflich?',
    birth: ['In welchem Jahr ist {X} geboren?', 'Aus welchem Jahrgang ist {X}?', 'Wann kam {X} zur Welt?'],
    birthA: ['{X} wurde {Y} geboren.', '{X} ist Jahrgang {Y}.', '{X} kam {Y} zur Welt.'],
    birthYes: ['Ist {X} {Y} geboren?'],
    birthYesA: ['Ja, {X} wurde {Y} geboren.'],
    birthNext: 'Und wann ist {pron} geboren?',
    tpWhen: ['Was erlebt {X} {W}?', 'Was passiert {W} mit {Xd}?', 'Was verändert sich {W} für {Xa}?'],
    tpWhenA: ['{Wc} erlebt {X} «{E}».', 'Für {Xa} wird {W} «{E}» zum Einschnitt.', '{Wc} kommt es für {Xa} zu «{E}».'],
    tpAsk: ['Wann erlebt {X} «{E}»?', 'In welchem Jahr erlebt {X} «{E}»?'],
    tpAskA: ['{X} erlebt «{E}» {W}.', '«{E}» fällt bei {Xd} in die Zeit {Wp}.'],
    tpMean: ['Was bedeutet «{E}» für {Xa}?', 'Warum ist «{E}» für {Xa} wichtig?'],
    tpList: ['Welche Wendepunkte gibt es im Leben von {Xd}?', 'Was sind die wichtigsten Einschnitte für {Xa}?'],
    tpListLead: 'Die wichtigsten Wendepunkte für {Xa} sind ',
    tpNext: 'Und was erlebt {pron} {W}?',
    chapter: ['In welchem Kapitel steht {X} im Zentrum?', 'Welches Kapitel gehört vor allem {Xd}?',
      'Wo im Buch geht es vor allem um {Xa}?', 'In welchem Kapitel erfährt man am meisten über {Xa}?'],
    chapterA: ['Im Zentrum steht {X} im Kapitel «{K}».', 'Vor allem im Kapitel «{K}» geht es um {Xa}.', 'Am meisten erfährt man über {Xa} im Kapitel «{K}».'],
    chapterNext: 'Und in welchem Kapitel steht {pron} im Zentrum?',
    motive: ['Worum geht es {Xd} im Leben?', 'Was ist {Xd} am wichtigsten?', 'Was steckt hinter dem Handeln von {Xd}?', 'Was ist der Antrieb von {Xd}?'],
    motiveNext: 'Und was treibt {pronA} an?',
  },
  en: {
    direct: ["Who is {Xg} {R}?", "What is the name of {Xg} {R}?", "Do you know who {Xg} {R} is?"],
    directA: ['{Xgc} {R} is {Y}.', '{Y} is {Xg} {R}.', "{Xgc} {R}'s name is {Y}."],
    reverse: ['Whose {R} is {Y}?', '{Y} is whose {R}?', 'Whom does {Y} belong to as {R}?'],
    reverseA: ['{Y} is {RY}.', 'In my story, {Y} is {RY}.', '{Y} is {RY}; {X} is {RXp}.'],
    yes: ['Is {Y} {RY}?', 'Is it true that {Y} is {RY}?'],
    yesA: ['Yes, {Y} is {RY}.', 'Yes. {Y} is {RY}.'],
    yesX: ['Is {X} {RX}?'],
    yesXA: ['Yes, {X} is {RX}.'],
    married: ['Is {X} married?', 'Who is {X} actually married to?', 'Does {X} have a partner?'],
    marriedA: ['Yes, {X} is married to {Y}.', '{X} is married to {Y}; {Y} is {RY}.'],
    parents: ["Who are {Xg} parents?", 'Whom does {X} come from?', 'Who raised {X}?'],
    kids: ['Does {X} have children?', "What are {Xg} children called?"],
    sibs: ['Does {X} have siblings?', 'Whom did {X} grow up with?'],
    family: ["Tell me about {Xg} family.", "What is {Xg} family like?", "Who belongs to {Xg} family?"],
    yesPrefix: 'Yes. ',
    turn1: ['Who is {X}?', 'Tell me briefly about {X}.'],
    nextUnique: 'And who is {poss} {R}?',
    nextUniqueA: '{possc} {R} is {Y}.',
    nextAny: 'And how does {pron} relate to {Y}?',
    nextAnyA: '{Y} is {RY}.',
    job: ['What is {X} by profession?', 'How does {X} earn a living?', 'What does {X} work as?', 'What did {X} train as?'],
    jobYes: ['Does {X} work as {J}?'],
    jobYesA: ['Yes, {X} works as {J}.'],
    statusYes: ['Is {X} {J}?'],
    statusYesA: ['Yes, {X} is {J}.'],
    jobNext: 'And what does {pron} do for a living?',
    birth: ['In which year was {X} born?', 'What year was {X} born?', 'When did {X} come into the world?'],
    birthA: ['{X} was born in {Y}.', "{X}'s year of birth is {Y}.", '{X} came into the world in {Y}.'],
    birthYes: ['Was {X} born in {Y}?'],
    birthYesA: ['Yes, {X} was born in {Y}.'],
    birthNext: 'And when was {pron} born?',
    tpWhen: ['What does {X} go through {W}?', 'What happens to {X} {W}?', 'What changes for {X} {W}?'],
    tpWhenA: ['{Wc}, {X} goes through «{E}».', 'For {X}, «{E}» becomes a turning point {W}.', '{Wc}, «{E}» happens to {X}.'],
    tpAsk: ['When does {X} go through «{E}»?', 'In which year does {X} go through «{E}»?'],
    tpAskA: ['{X} goes through «{E}» {W}.', 'For {X}, «{E}» falls {W}.'],
    tpMean: ['What does «{E}» mean for {X}?', 'Why does «{E}» matter for {X}?'],
    tpList: ["What are the turning points in {Xg} life?", 'What are the most important turning points for {X}?'],
    tpListLead: 'The most important turning points for {X} are ',
    tpNext: 'And what does {pron} go through {W}?',
    chapter: ['In which chapter is {X} at the centre?', 'Which chapter belongs above all to {X}?',
      'Where in the book is it mostly about {X}?', 'In which chapter do you learn the most about {X}?'],
    chapterA: ['{X} is at the centre of the chapter «{K}».', 'Above all, the chapter «{K}» is about {X}.', 'You learn the most about {X} in the chapter «{K}».'],
    chapterNext: 'And in which chapter is {pron} at the centre?',
    motive: ['What matters to {X} in life?', 'What is most important to {X}?', "What lies behind {Xg} actions?", "What is {Xg} driving force?"],
    motiveNext: 'And what drives {pronA}?',
  },
};

function buildCoreFactSet(ctx) {
  const { langIsEn, figRows, eligibleFigIds, relationFacts = [], opts, samples, counts, unifiedSys, displayName } = ctx;
  const t = T[langIsEn ? 'en' : 'de'];
  const repeat = Math.max(1, Math.min(4, Math.round(Number(opts.coreFactRepeat) || 2)));
  const target = 8 * repeat;
  const answerCap = 2 * repeat;
  const seed = opts.valSeed;
  ctx.coreFactsByFig = new Map();
  const usedAnswers = new Map();
  const usedPrompts = new Set();

  // Ein Sample je (Fragen-Kette, Antworten). `turns`: [[q, a], …].
  const push = (fig, factId, factIds, turns, tag) => {
    const key = turns.map(([q]) => q).join('\u0000');
    if (usedPrompts.has(key)) return false;
    // Gedeckelt wird die Antwort, die den Fakt trägt (der letzte Zug); die
    // Einstiegsantwort eines Gesprächs ist das kurze Porträt.
    const last = turns[turns.length - 1][1];
    if (turns.some(([q, a]) => !q || !a) || (usedAnswers.get(last) || 0) >= answerCap) return false;
    usedPrompts.add(key);
    usedAnswers.set(last, (usedAnswers.get(last) || 0) + 1);
    const messages = [{ role: 'system', content: unifiedSys }];
    for (const [q, a] of turns) messages.push({ role: 'user', content: q }, { role: 'assistant', content: a });
    samples.push({
      id: `core|set|${fig.fig_id}|${tag}`, type: 'core', task: 'coreFact', factId, factIds: [...new Set(factIds)],
      unit: 'fig:' + fig.fig_id, core: true, coreFact: true, tier: 'main', messages,
    });
    counts.core = (counts.core || 0) + 1;
    return true;
  };

  // Formen eines Fakts reihum ausgeben, bis `target` erreicht ist. Eine Form:
  // { qs, as, factIds?, turns? } — `turns` (Mehrturn) liefert fertige Ketten.
  const emitFact = (fig, factId, forms) => {
    const queues = forms.map((f, fi) => {
      if (f.turns) return f.turns.map(tr => ({ turns: tr, factIds: f.factIds || [factId] }));
      const qs = [...new Set(f.qs.filter(Boolean))];
      const as = [...new Set(f.as.filter(Boolean))];
      if (!qs.length || !as.length) return [];
      const off = Math.floor(hashSplit(factId + '|' + fi, seed) * as.length);
      return qs.map((q, i) => ({ turns: [[q, as[(i + off) % as.length]]], factIds: f.factIds || [factId] }));
    });
    let n = 0, round = 0, k = 0;
    while (n < target && queues.some(q => q.length > round)) {
      for (const q of queues) {
        if (n >= target) break;
        const item = q[round];
        if (item && push(fig, factId, item.factIds, item.turns, `${factId}|${k++}`)) n++;
      }
      round++;
    }
    return n;
  };

  for (const f0 of figRows) {
    if (!eligibleFigIds?.has(f0.fig_id) || ctx.tierByFig?.get(f0.fig_id) !== 'main') continue;
    const info = ctx.figNameInfo?.get(f0.fig_id);
    if (info && !info.proper) continue;
    const X = info?.name || f0.name;
    const f = { ...f0, name: X };
    const g = genderOf(f);
    const Xg = genitive(X, langIsEn);
    if (!Xg) continue;
    const Xd = langIsEn ? X : declineName(X, 'dat') || X;
    const Xa = langIsEn ? X : declineName(X, 'akk') || X;
    const pron = pronoun(g, langIsEn) ? pronoun(g, langIsEn).toLowerCase() : X;
    const pronA = langIsEn ? (g === 'm' ? 'him' : g === 'f' ? 'her' : X) : (g === 'm' ? 'ihn' : g === 'f' ? 'sie' : X);
    const base = { X, Xg, Xgc: capFirst(Xg), Xd, Xa };
    const facts = [];
    ctx.coreFactsByFig.set(f.fig_id, facts);
    const typePhrase = figureTypePhrase(f.typ, g, langIsEn);
    const identity = (v) => (langIsEn
      ? [`${X} is ${typePhrase || 'a character'} in «${displayName}».`, `In «${displayName}», ${X} is ${typePhrase || 'one of the characters'}.`]
      : [`${X} ist ${typePhrase || 'eine Figur'} in «${displayName}».`, `In «${displayName}» ist ${X} ${typePhrase || 'eine der Figuren'}.`])[v % 2];
    const multi = (nextQ, nextAs) => t.turn1.map((q1, i) => [[fill(q1, base), identity(i)], [nextQ, nextAs[i % nextAs.length]]]);

    // ── Familie ─────────────────────────────────────────────────────────
    const fam = familyOf(f, relationFacts, langIsEn, KIN);
    const relKey = (r) => {
      const hit = relationFacts.find(x => (x.a.fig_id === f.fig_id && x.b.fig_id === r.other.fig_id) || (x.b.fig_id === f.fig_id && x.a.fig_id === r.other.fig_id));
      return hit ? 'rel:' + hit.key : null;
    };
    const famIds = fam.map(relKey).filter(Boolean);
    const familyAnswers = fam.length
      ? [0, 1].map(form => fam.map((r, i) => familySentence(f, r, langIsEn, (i + form) % 2)).join(' '))
      : [];
    for (const r of fam) {
      const factId = relKey(r);
      if (!factId) continue;
      const Y = r.other.name;
      const gY = genderOf(r.other);
      const RX = roleNoun(inverseTyp(r.typ), g, langIsEn);
      const v = {
        ...base, Y, Yd: langIsEn ? Y : declineName(Y, 'dat') || Y, R: r.noun,
        RY: rolePhrase(X, r, r.typ, langIsEn),
        RX: RX ? rolePhrase(Y, RX, inverseTyp(r.typ), langIsEn) : '',
        RXp: RX && possessive(gY, RX.g, langIsEn) ? `${possessive(gY, RX.g, langIsEn)} ${RX.noun}` : '',
      };
      facts.push({ id: factId, label: langIsEn ? `${Y} (${r.noun})` : `${Y} (${r.noun})` });
      const unique = fam.filter(x => x.typ === r.typ && x.noun === r.noun).length === 1;
      const poss = possessive(g, r.g, langIsEn);
      const sameTyp = fam.filter(x => x.typ === r.typ);
      const yesList = (fam2) => t.yesPrefix + fam2.map(x => familySentence(f, x, langIsEn, 1)).join(' ');
      const forms = [
        unique ? { qs: t.direct.map(q => fill(q, v)), as: t.directA.map(a => fill(a, v)) } : null,
        { qs: t.reverse.map(q => fill(q, v)), as: t.reverseA.filter(a => v.RXp || !a.includes('{RXp}')).map(a => fill(a, v)) },
        { qs: t.yes.map(q => fill(q, v)), as: t.yesA.map(a => fill(a, v)) },
        v.RX ? { qs: t.yesX.map(q => fill(q, v)), as: t.yesXA.map(a => fill(a, v)) } : null,
        r.typ === 'ehepartner' && unique ? { qs: t.married.map(q => fill(q, v)), as: t.marriedA.map(a => fill(a, v)) } : null,
        r.typ === 'elternteil' ? { qs: t.parents.map(q => fill(q, v)), as: [yesList(sameTyp).slice(t.yesPrefix.length), familyAnswers[0]], factIds: sameTyp.map(relKey).filter(Boolean) } : null,
        r.typ === 'kind' ? { qs: t.kids.map(q => fill(q, v)), as: [yesList(sameTyp)], factIds: sameTyp.map(relKey).filter(Boolean) } : null,
        r.typ === 'geschwister' ? { qs: t.sibs.map(q => fill(q, v)), as: [yesList(sameTyp)], factIds: sameTyp.map(relKey).filter(Boolean) } : null,
        familyAnswers.length ? { qs: t.family.map(q => fill(q, v)), as: familyAnswers, factIds: famIds } : null,
        {
          turns: unique && poss
            ? multi(fill(t.nextUnique, { ...v, poss }), [fill(t.nextUniqueA, { ...v, possc: capFirst(poss) })])
            : multi(fill(t.nextAny, { ...v, pron }), [fill(t.nextAnyA, v)]),
        },
      ].filter(Boolean);
      emitFact(f, factId, forms);
    }

    // ── Beruf und Werdegang ─────────────────────────────────────────────
    const J = jobInSentence(berufHead(f.beruf));
    if (J) {
      const factId = 'fig:' + f.fig_id + ':beruf';
      facts.push({ id: factId, label: J });
      const status = isStatus(J);
      const v = { ...base, J, possN: langIsEn ? '' : (g === 'f' ? 'ihr' : 'sein') };
      const jobAs = status
        ? (langIsEn ? [`${X} is ${J}.`, `At the moment, ${X} is ${J}.`] : [`${X} ist ${J}.`, `Zurzeit ist ${X} ${J}.`])
        : (langIsEn ? [`${X} works as ${J}.`, `By profession, ${X} is ${J}.`] : [`${X} arbeitet als ${J}.`, `Von Beruf ist ${X} ${J}.`]);
      const career = careerSentences(f, J, langIsEn);
      emitFact(f, factId, [
        { qs: t.job.map(q => fill(q, v).replace(/\s+\?/, '?').replace(/\s{2,}/g, ' ')), as: [...jobAs, ...career] },
        { qs: (status ? t.statusYes : t.jobYes).map(q => fill(q, v)), as: (status ? t.statusYesA : t.jobYesA).map(a => fill(a, v)) },
        { turns: multi(fill(t.jobNext, { pron }), jobAs) },
      ]);
    }

    // ── Geburtsjahr (nur sicher) ────────────────────────────────────────
    const year = birthYear(f, ctx.eventsByFigPk);
    if (year) {
      const factId = 'fig:' + f.fig_id + ':geburt';
      facts.push({ id: factId, label: String(year) });
      const v = { ...base, Y: String(year) };
      const as = t.birthA.map(a => fill(a, v));
      emitFact(f, factId, [
        { qs: t.birth.map(q => fill(q, v)), as },
        { qs: t.birthYes.map(q => fill(q, v)), as: t.birthYesA.map(a => fill(a, v)) },
        { turns: multi(fill(t.birthNext, { pron }), as) },
      ]);
    }

    // ── Wendepunkte ─────────────────────────────────────────────────────
    const tps = turningPoints(f, info?.aliases || [X], ctx.eventsByFigPk, langIsEn);
    const tpFacts = tps.map((tp, i) => ({ ...tp, id: `fig:${f.fig_id}:tp:${i}` }));
    const tpList = tpFacts.length >= 2
      ? capFirst(fill(t.tpListLead, base)) + joinList(tpFacts.map(tp => `«${tp.text}»${tp.when ? ` (${tp.when})` : ''}`), langIsEn) + '.'
      : '';
    tpFacts.forEach((tp, i) => {
      facts.push({ id: tp.id, label: tp.text + (tp.when ? ` (${tp.when})` : '') });
      const W = tp.when ? whenAdverb(tp.when, langIsEn) : null;
      const v = { ...base, E: tp.text, W: W || '', Wc: W ? capFirst(W) : '', Wp: tp.when ? (langIsEn ? tp.when : `um ${tp.when}`) : '' };
      const mean = tp.meaning ? [tp.meaning] : [];
      const forms = [
        W ? { qs: t.tpWhen.map(q => fill(q, v)), as: t.tpWhenA.map(a => fill(a, v)).map(a => (mean[0] ? a + ' ' + mean[0] : a)).concat(t.tpWhenA.map(a => fill(a, v))) } : null,
        W ? { qs: t.tpAsk.map(q => fill(q, v)), as: t.tpAskA.map(a => fill(a, v)) } : null,
        mean.length ? { qs: t.tpMean.map(q => fill(q, v)), as: [mean[0], `«${tp.text}» ${langIsEn ? 'matters for' : 'ist wichtig für'} ${Xa}: ${mean[0]}`] } : null,
        tpList ? { qs: t.tpList.map(q => fill(q, v)), as: [tpList], factIds: tpFacts.map(x => x.id) } : null,
        W ? { turns: multi(fill(t.tpNext, { pron, W }), [fill(t.tpWhenA[i % 3], v)]) } : null,
      ].filter(Boolean);
      emitFact(f, tp.id, forms);
    });

    // ── Kapitel, in dem die Figur im Zentrum steht ──────────────────────
    const K = (ctx.appearancesByFigPk?.get(f.pk) || []).find(Boolean);
    if (K) {
      const factId = 'fig:' + f.fig_id + ':kapitel';
      facts.push({ id: factId, label: K });
      const v = { ...base, K };
      const as = t.chapterA.map(a => fill(a, v));
      emitFact(f, factId, [
        { qs: t.chapter.map(q => fill(q, v)), as },
        { turns: multi(fill(t.chapterNext, { pron }), as) },
      ]);
    }

    // ── Antrieb in einem Satz ───────────────────────────────────────────
    const motive = motiveSentence(f, X, langIsEn);
    if (motive) {
      const factId = 'fig:' + f.fig_id + ':motiv';
      facts.push({ id: factId, label: motive });
      // Zweite Fassung mit dem Namen statt des Pronomens am Satzanfang
      // («Er sucht …» → «Stefan sucht …», «Sein Ziel …» → «Fabios Ziel …»).
      const named = motive.replace(/^(Er|Sie|He|She)\s/, X + ' ')
        .replace(/^(Sein|Seine|Seinem|Seinen|Seiner|Ihr|Ihre|Ihrem|Ihren|Ihrer|His|Her)\s/, Xg + ' ');
      const motiveVariants = [...new Set([motive, named])];
      emitFact(f, factId, [
        { qs: t.motive.map(q => fill(q, base)), as: motiveVariants },
        { turns: multi(fill(t.motiveNext, { pronA }), motiveVariants) },
      ]);
    }
  }

  // Porträts zählen für jeden Kernfakt, den ihre Antwort nennt.
  for (const s of samples) {
    if (s.task !== 'figureCore' || !s.factId) continue;
    const figId = s.factId.replace(/^fig:/, '').replace(/:core$/, '');
    const list = ctx.coreFactsByFig.get(figId);
    if (!list) continue;
    const answer = s.messages[2].content;
    const hits = list.filter(x => x.id.startsWith('rel:') ? answer.includes(x.label.replace(/\s*\(.*\)$/, '')) : answer.includes(x.label));
    if (hits.length) s.factIds = [s.factId, ...hits.map(x => x.id)];
  }
}

// Die wichtigsten persönlichen Wendepunkte mit sicherem Jahr
// (figures.js#turningPoint, Rang nach Untertyp), höchstens TURNS_MAX. Ein aus
// dem Kontext erschlossenes Jahr (`datum_unsicher`) ist kein Kernfakt.
function turningPoints(f, names, eventsByFigPk, langIsEn) {
  const evs = (eventsByFigPk?.get(f.pk) || []).filter(e => e.ereignis && e.datum_year && !e.datum_unsicher
    && String(e.typ || 'persoenlich') !== 'extern' && !/^extern/.test(String(e.subtyp || '')) && e.subtyp !== 'geburt');
  const out = [];
  const rest = new Map(evs.map(e => [e, true]));
  while (out.length < TURNS_MAX && rest.size) {
    const pool = new Map([[f.pk, [...rest.keys()]]]);
    const tp = turningPoint(f, names, pool, langIsEn);
    if (!tp) break;
    const ev = [...rest.keys()].find(e => String(e.ereignis).trim().replace(/[.\s]+$/, '') === tp.text);
    if (!ev) break;
    rest.delete(ev);
    const when = tp.when || eventWhen(ev, langIsEn).when || '';
    // Zwei Wendepunkte am selben Datum machten «Was erlebt X im August
    // 1999?» mehrdeutig — der wichtigere bleibt.
    if (out.some(x => x.when === when)) continue;
    out.push({ ...tp, when });
  }
  // Chronologisch, wie sie erzählt werden.
  return out.sort((a, b) => (parseInt(a.when, 10) || 9999) - (parseInt(b.when, 10) || 9999));
}

// Antrieb aus der Analyse (`figures.motivation`), erster Satz, nur wenn er
// die Figur nennt oder mit einem Pronomen auf sie zeigt.
function motiveSentence(f, X, langIsEn) {
  const s = firstSentences(f.motivation, 1);
  if (!s || s.length < 25 || s.length > 300) return '';
  if (s.includes(X) || /^(Er|Sie|Ihm|Ihr|Sein|Seine|He|She|His|Her)\b/.test(s)) return s;
  return '';
}

module.exports = { buildCoreFactSet, CORE_SET_TEXT: T, motiveSentence, turningPoints };

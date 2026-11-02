'use strict';

// Ereignisse und Kapitel als Faktenkarten mit Varianten. Jede Karte ist eine
// Facette (wann, wer, wo, warum) mit eigener Antwort; alle Facetten eines
// Ereignisses teilen die Einheit `evt:<i>` mit den übrigen Ereignis-Samples
// (author-chat/events.js), damit der Split sie nicht trennt.
//
// «Was folgt daraus» gibt es nicht: das Datenmodell kennt keine Kausal- oder
// Folgebeziehung zwischen Ereignissen, nur die erzählte Reihenfolge
// (author-chat/events.js «davor/danach»).
//
// Kapitel: «Was passiert im Kapitel X?» wird aus den Ereignissen des Kapitels
// beantwortet — nie aus einer Bewertung (chapter_reviews). Ohne Ereignis keine
// Aufgabe. Kapitelkarten sind Kernwissen (`core`).

const { isAdverbialWhen } = require('./words');
const { bestTier } = require('./relations');
const { nameRegex } = require('../../lib/names');
const { leadSafe } = require('../author-chat/event-data');
const { fillCase, declineName } = require('./naming');

// Zeitangabe als Adverbial: «im August 1998», «Ende August 1999», «1987».
// null, wenn sich keine sichere Form bilden lässt.
const MONTH_SEASON = /^(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Frühling|Frühjahr|Sommer|Herbst|Winter|January|February|March|June|July|October|December|spring|summer|autumn|fall|winter)\b/i;
function whenAdverb(d, langIsEn) {
  const t = String(d || '').trim();
  if (!t || /^(unbekannt|unknown)$/i.test(t)) return null;
  // Tagesdatum: «am 1. Januar 2000» / «on 1 January 2000».
  if (/^\d{1,2}\.?\s+\p{L}/u.test(t)) return (langIsEn ? 'on ' : 'am ') + t;
  if (isAdverbialWhen(t) || /^(Anfang|Mitte|Ende|early|mid|late)\b/i.test(t)) return t;
  if (MONTH_SEASON.test(t)) return (langIsEn ? 'in ' : 'im ') + t;
  return null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function joinList(items, langIsEn) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + (langIsEn ? ' and ' : ' und ') + items[items.length - 1];
}

const EQ = {
  de: {
    when: ['Wann passiert «{e}»?', 'Wann findet «{e}» statt?', 'Zu welcher Zeit geschieht «{e}»?'],
    who: ['Wer ist bei «{e}» dabei?', 'Wer ist an «{e}» beteiligt?', 'Welche Figuren erleben «{e}»?'],
    where: ['Wo spielt «{e}»?', 'An welchem Schauplatz geschieht «{e}»?', 'Wo findet «{e}» statt?'],
    why: ['Warum ist «{e}» wichtig?', 'Welche Bedeutung hat «{e}»?', 'Was bedeutet «{e}» für die Geschichte?'],
  },
  en: {
    when: ['When does «{e}» happen?', 'When does «{e}» take place?', 'At what time does «{e}» happen?'],
    who: ['Who is part of «{e}»?', 'Who is involved in «{e}»?', 'Which characters experience «{e}»?'],
    where: ['Where does «{e}» take place?', 'At which setting does «{e}» happen?', 'Where is «{e}» set?'],
    why: ['Why does «{e}» matter?', 'What is the significance of «{e}»?', 'What does «{e}» mean for the story?'],
  },
};

function buildEventCore(ctx, emitCard) {
  const { langIsEn, events = [] } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const q = (key, e) => EQ[lang][key].map(t => t.replace('{e}', e));
  for (const e of events) {
    const E = e.ereignis;
    const unit = 'evt:' + e.i;
    const tier = bestTier(ctx, e.figs.filter(f => f.fig_id));
    const card = (facet, fields) => ({ id: `evt:${e.i}:${facet}`, kind: 'event', unit, tier, subject: E, fields });
    const adv = whenAdverb(e.datum, langIsEn);
    if (e.datum && !/^(unbekannt|unknown)$/i.test(String(e.datum).trim())) {
      emitCard(card('when', { wann: e.datum }), {
        task: 'eventCore', questions: q('when', E),
        answers: adv
          ? (langIsEn
            ? [`«${E}» happens ${adv}.`, `The time of «${E}»: ${e.datum}.`, `${leadSafe(cap(E))} takes place ${adv}.`]
            : [`«${E}» passiert ${adv}.`, `Zeitpunkt von «${E}»: ${e.datum}.`, `${leadSafe(cap(E))} geschieht ${adv}.`])
          : (langIsEn
            ? [`The time of «${E}»: ${e.datum}.`, `The story dates «${E}» to this time: ${e.datum}.`]
            : [`Zeitpunkt von «${E}»: ${e.datum}.`, `Die Geschichte datiert «${E}» so: ${e.datum}.`]),
      });
    }
    // «Wer ist dabei?» nur, wenn mehr Figuren beteiligt sind, als der Titel
    // nennt — sonst steht die Antwort schon in der Frage.
    // Auch der Vorname allein zählt («Renate tritt … bei» bei «Renate Müller»).
    const nameForms = (f) => [...new Set([...(f.names || [f.name]), ...(f.names || [f.name]).map(n => String(n || '').split(/\s+/)[0])])]
      .filter(n => n && n.length >= 3);
    const inTitle = e.figs.filter(f => nameForms(f).some(n => nameRegex(n).test(E)));
    const extra = e.figs.filter(f => !inTitle.includes(f));
    if (extra.length) {
      const names = e.figs.map(f => f.name);
      const more = joinList(extra.map(f => f.name), langIsEn);
      const named = joinList(inTitle.map(f => f.name), langIsEn);
      const verb = extra.length > 1 ? (langIsEn ? 'are' : 'sind') : (langIsEn ? 'is' : 'ist');
      emitCard(card('who', { figuren: names }), {
        task: 'eventCore', questions: q('who', E),
        answers: inTitle.length
          ? (langIsEn
            ? [`Besides ${named}, ${more} ${verb} there.`, `Apart from ${named}, ${more} ${verb} involved as well.`]
            : [`Neben ${named} ${verb} ${more} dabei.`, `Ausser ${named} ${verb} auch ${more} beteiligt.`])
          : (langIsEn
            ? [`${cap(more)} ${verb} there.`, `${cap(more)} ${verb} involved.`]
            : [`Dabei ${verb} ${more}.`, `${cap(more)} ${verb} beteiligt.`]),
      });
    }
    if (e.locs.length) {
      const names = e.locs.map(l => '«' + l.name + '»');
      const list = joinList(names, langIsEn);
      emitCard(card('where', { schauplaetze: e.locs.map(l => l.name) }), {
        task: 'eventCore', questions: q('where', E),
        answers: langIsEn
          ? [`«${E}» is set at ${list}.`, `Setting of «${E}»: ${list}.`]
          : [`«${E}» spielt am Schauplatz ${list}.`, `Schauplatz von «${E}»: ${list}.`],
      });
    }
    const bed = String(e.bedeutung || '').trim();
    if (bed) {
      // Persönliches Ereignis: die Frage nach der Bedeutung für die Figur.
      const personal = String(e.typ || '').toLowerCase() !== 'extern' && e.figs.length === 1 && e.figs[0].fig_id;
      const forFig = personal
        ? [langIsEn ? `Why does «${E}» matter for ${e.figs[0].name}?` : `Warum ist «${E}» für ${declineName(e.figs[0].name, 'akk') || e.figs[0].name} wichtig?`]
        : [];
      emitCard(card('why', { bedeutung: bed }), {
        task: 'eventCore', questions: [...forFig, ...q('why', E)],
        answers: langIsEn
          ? [bed, `«${E}» matters because of this: ${bed}`]
          : [bed, `«${E}» ist für die Geschichte wichtig: ${bed}`],
      });
    }
  }
}

// ── Kapitel ──────────────────────────────────────────────────────────────
// Pro Kapitel drei Zusammenfassungen: kurz (1–2 Sätze), mittel (die 5–8
// wichtigsten Ereignisse chronologisch, Fliesstext mit Jahreszahlen) und je
// tragender Figur («Worum geht es für Stefan in «Der Vater»?»). Keine
// «Zuerst: … Dann: …»-Ketten: die laden zur Endlosschleife ein. Jede Form mit
// eigenen Fragen und vier Antwortfassungen.
//
// Ein Ereignis zählt nur für das Kapitel, in dem seine verknüpften Abschnitte
// liegen; ohne Abschnitt nur, wenn es genau einem Kapitel zugeordnet ist.
// Weicht die Kapitel-Zuordnung vom Kapitel der Abschnitte ab, steht das in
// `ctx.chapterMismatches` (Statistik) — korrigiert wird nichts.
const CQ = {
  de: {
    short: ['Worum geht es im Kapitel «{k}»?', 'Fass das Kapitel «{k}» kurz zusammen.', 'Was ist das Kapitel «{k}» in einem Satz?',
      'Wovon handelt «{k}»?', 'Worum dreht sich das Kapitel «{k}»?', 'Sag mir kurz, worum es in «{k}» geht.',
      'Was ist der Kern des Kapitels «{k}»?', 'Fass «{k}» in ein, zwei Sätzen zusammen.'],
    medium: ['Was passiert im Kapitel «{k}»?', 'Gib mir einen Überblick über das Kapitel «{k}».', 'Fass das Kapitel «{k}» zusammen.',
      'Was geschieht im Kapitel «{k}»?', 'Erzähl mir, was im Kapitel «{k}» passiert.', 'Was ist der Inhalt des Kapitels «{k}»?',
      'Wie verläuft das Kapitel «{k}»?', 'Was passiert der Reihe nach im Kapitel «{k}»?'],
    figure: ['Worum geht es für {n} im Kapitel «{k}»?', 'Was erlebt {n} im Kapitel «{k}»?', 'Welche Rolle spielt {n} im Kapitel «{k}»?',
      'Was passiert mit {n:dat} im Kapitel «{k}»?'],
    list: ['Welche Kapitel hat das Buch?', 'Wie heissen die Kapitel?', 'Wie ist das Buch aufgebaut?', 'Wie viele Kapitel hast du?',
      'Nenn mir alle Kapitel in der richtigen Reihenfolge.'],
    first: ['Wie heisst das erste Kapitel?', 'Mit welchem Kapitel beginnt das Buch?'],
    last: ['Wie heisst das letzte Kapitel?', 'Mit welchem Kapitel endet das Buch?'],
  },
  en: {
    short: ['What is the chapter «{k}» about?', 'Summarize the chapter «{k}» briefly.', 'What is the chapter «{k}» in one sentence?',
      'What does «{k}» deal with?', 'What does the chapter «{k}» revolve around?', 'Tell me briefly what «{k}» is about.',
      'What is the core of the chapter «{k}»?', 'Sum up «{k}» in a sentence or two.'],
    medium: ['What happens in the chapter «{k}»?', 'Give me an overview of the chapter «{k}».', 'Summarize the chapter «{k}».',
      'What goes on in the chapter «{k}»?', 'Tell me what happens in the chapter «{k}».', 'What is the content of the chapter «{k}»?',
      'How does the chapter «{k}» unfold?', 'What happens, step by step, in the chapter «{k}»?'],
    figure: ['What is the chapter «{k}» about for {n}?', 'What does {n} go through in the chapter «{k}»?', 'What role does {n} play in the chapter «{k}»?',
      'What happens to {n} in the chapter «{k}»?'],
    list: ['Which chapters does the book have?', 'What are the chapters called?', 'How is the book structured?', 'How many chapters do you have?',
      'Name all chapters in the right order.'],
    first: ['What is the first chapter called?', 'Which chapter does the book begin with?'],
    last: ['What is the last chapter called?', 'Which chapter does the book end with?'],
  },
};
const SUMMARY_MAX = 8;
const SUMMARY_MIN = 5;

// Datum als Adverbial (`whenAdverb`), nur wenn sicher.
const sureWhen = (e, langIsEn) => (e.unsure ? null : whenAdverb(e.datum, langIsEn));
const byDate = (a, b) => (a.year || 1e4) - (b.year || 1e4) || (a.month || 0) - (b.month || 0) || (a.day || 0) - (b.day || 0) || a.i - b.i;

// Kapitel eines Ereignisses: das der verknüpften Abschnitte, sonst die
// einzige Kapitel-Zuordnung.
function chapterOfEvent(e, pageChapterById, mismatches) {
  const fromPages = [...new Set((e.pageIds || []).map(pid => pageChapterById?.get(pid)).filter(Boolean))];
  if (fromPages.length) {
    for (const k of e.kapitel) {
      if (!fromPages.includes(k)) mismatches.push({ event: e.ereignis, kapitel: k, abschnittKapitel: fromPages });
    }
    return fromPages.length === 1 ? fromPages[0] : null;
  }
  return e.kapitel.length === 1 ? e.kapitel[0] : null;
}

// Fliesstext durch die Ereignisse: Anfang, Mitte (Verbindungen reihum, jede
// höchstens zweimal), Ende. `variant` verschiebt Einstieg und Reihenfolge der
// Verbindungen — vier verschiedene Fassungen derselben Fakten.
function chronicle(name, evs, langIsEn, variant) {
  const w = (e) => sureWhen(e, langIsEn);
  const E = (e) => `«${e.ereignis}»`;
  const sp = (x) => (x ? ' ' + x : '');
  const de = {
    open: [(e) => `Das Kapitel «${name}» beginnt${sp(w(e))} mit ${E(e)}.`, (e) => `Am Anfang des Kapitels «${name}» steht${sp(w(e))} ${E(e)}.`],
    mid: [(e) => (w(e) ? `${cap(w(e))} folgt ${E(e)}.` : `Darauf folgt ${E(e)}.`), (e) => `Danach kommt es${sp(w(e))} zu ${E(e)}.`,
      (e) => (w(e) ? `${cap(w(e))} geschieht ${E(e)}.` : `Dann geschieht ${E(e)}.`), (e) => `Ausserdem erzählt das Kapitel${sp(w(e))} von ${E(e)}.`],
    close: [(e) => `Am Ende steht${sp(w(e))} ${E(e)}.`, (e) => `Den Schluss bildet${sp(w(e))} ${E(e)}.`],
  };
  const en = {
    open: [(e) => `The chapter «${name}» opens${w(e) ? ' ' + w(e) : ''} with ${E(e)}.`, (e) => `At the start of the chapter «${name}»${w(e) ? ', ' + w(e) + ',' : ''} comes ${E(e)}.`],
    mid: [(e) => `${w(e) ? cap(w(e)) + ', ' : 'Next, '}${E(e)} follows.`, (e) => `After that${w(e) ? ', ' + w(e) + ',' : ''} comes ${E(e)}.`,
      (e) => `Then${w(e) ? ', ' + w(e) + ',' : ''} ${E(e)} happens.`, (e) => `The chapter also tells${w(e) ? ', ' + w(e) + ',' : ''} of ${E(e)}.`],
    close: [(e) => `At the end${w(e) ? ', ' + w(e) + ',' : ''} comes ${E(e)}.`, (e) => `It closes${w(e) ? ' ' + w(e) : ''} with ${E(e)}.`],
  };
  const t = langIsEn ? en : de;
  const out = [t.open[variant % 2](evs[0])];
  evs.slice(1, -1).forEach((e, i) => out.push(t.mid[(i + variant) % t.mid.length](e)));
  if (evs.length > 1) out.push(t.close[(variant >> 1) % 2](evs[evs.length - 1]));
  return out.join(' ');
}

function buildChapterCore(ctx, emitCard) {
  const { langIsEn, events = [], chapterKeys = [], chapterNameByKey, displayName } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const q = CQ[lang];
  const decl = { gender: 'n', role: false, langIsEn };
  const mismatches = [];
  ctx.chapterMismatches = mismatches;
  // Kapitel in Lesereihenfolge, ohne «Sonstige Abschnitte» (Schlüssel 0).
  const chapters = chapterKeys.filter(k => k !== 0).map(k => chapterNameByKey.get(k)).filter(Boolean);
  const order = new Map(chapters.map((n, i) => [n, i]));
  const byCh = new Map();
  for (const e of events) {
    const k = chapterOfEvent(e, ctx.pageChapterById, mismatches);
    if (!k) continue;
    if (!byCh.has(k)) byCh.set(k, []);
    byCh.get(k).push(e);
  }
  const tierRank = { main: 0, side: 1, minor: 2 };
  for (const [name, all] of [...byCh].sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9))) {
    const evs = [...all].sort(byDate);
    // Die wichtigsten 5–8: mit Bedeutung und Hauptfigur zuerst, dann über das
    // Kapitel verteilt; erzählt wird chronologisch.
    const weight = (e) => (e.bedeutung ? 0 : 1) + (e.figs.some(f => ctx.tierByFig?.get(f.fig_id) === 'main') ? 0 : 1);
    const n = Math.min(SUMMARY_MAX, Math.max(SUMMARY_MIN, Math.ceil(evs.length / 3)), evs.length);
    const top = evs.map((e, i) => [e, weight(e), Math.abs(i - (evs.length - 1) / 2)])
      .sort((a, b) => a[1] - b[1] || b[2] - a[2]).slice(0, n).map(([e]) => e).sort(byDate);
    // Tragende Figuren: am häufigsten beteiligt, Hauptfiguren zuerst.
    const figCount = new Map();
    for (const e of evs) for (const f of e.figs) if (f.fig_id) figCount.set(f.fig_id, { f, n: (figCount.get(f.fig_id)?.n || 0) + 1 });
    const figs = [...figCount.values()]
      .sort((a, b) => (tierRank[ctx.tierByFig?.get(a.f.fig_id)] ?? 2) - (tierRank[ctx.tierByFig?.get(b.f.fig_id)] ?? 2) || b.n - a.n)
      .slice(0, 3).map(x => x.f);
    const who = joinList(figs.slice(0, 2).map(f => f.name), langIsEn);
    const key = top.find(e => e.bedeutung) || top[Math.floor(top.length / 2)];
    const kw = sureWhen(key, langIsEn);
    const years = top.map(e => (e.unsure ? null : e.year)).filter(Boolean);
    const span = years.length >= 2 && years[0] !== years[years.length - 1]
      ? (langIsEn ? ` between ${years[0]} and ${years[years.length - 1]}` : ` zwischen ${years[0]} und ${years[years.length - 1]}`)
      : years.length ? (langIsEn ? ` in ${years[0]}` : ` im Jahr ${years[0]}`) : '';
    const K = `«${key.ereignis}»${kw ? (langIsEn ? ' ' + kw : ' ' + kw) : ''}`;
    const unit = 'chap:' + name;
    const fields = { ereignisse: top.map(e => e.ereignis), figuren: figs.map(f => f.name), kapitel: name };
    const shortAs = who
      ? (langIsEn
        ? [`The chapter «${name}» revolves around ${who}; at its centre is ${K}.`, `«${name}» is above all about ${who}${span}. The key moment is ${K}.`,
           `«${name}» tells${span} of ${who}; central is ${K}.`, `In «${name}», ${who} ${figs.length > 1 ? 'are' : 'is'} at the centre, and it comes to ${K}.`]
        : [`Das Kapitel «${name}» dreht sich um ${who}; im Mittelpunkt steht ${K}.`, `Im Kapitel «${name}» geht es vor allem um ${who}${span}. Zentral ist ${K}.`,
           `«${name}» erzählt${span} von ${who}, zentral ist ${K}.`, `In «${name}» ${figs.length > 1 ? 'stehen' : 'steht'} ${who} im Zentrum, und es kommt zu ${K}.`])
      : (langIsEn
        ? [`The chapter «${name}» leads${span} from «${top[0].ereignis}» to «${top[top.length - 1].ereignis}».`, `At the centre of «${name}» is ${K}.`]
        : [`Das Kapitel «${name}» führt${span} von «${top[0].ereignis}» bis zu «${top[top.length - 1].ereignis}».`, `Im Mittelpunkt von «${name}» steht ${K}.`]);
    emitCard({ id: `chap:${name}:short`, kind: 'chapter', unit, core: true, subject: name, fields }, {
      task: 'chapterCore', questions: q.short.map(t => t.replace('{k}', name)), answers: shortAs, count: q.short.length,
    });
    if (top.length >= 2) {
      emitCard({ id: 'chap:' + name, kind: 'chapter', unit, core: true, subject: name, fields }, {
        task: 'chapterCore', questions: q.medium.map(t => t.replace('{k}', name)),
        answers: [0, 1, 2, 3].map(v => chronicle(name, top, langIsEn, v)), count: q.medium.length,
      });
    }
    // Je tragender Figur mit mindestens zwei Ereignissen im Kapitel.
    for (const f of figs) {
      const own = evs.filter(e => e.figs.some(x => x.fig_id === f.fig_id)).slice(0, 6);
      if (own.length < 2) continue;
      const item = (e) => `«${e.ereignis}»${!e.unsure && e.datum ? ` (${e.datum})` : ''}`;
      const chain = own.map((e, i) => {
        const w = sureWhen(e, langIsEn);
        const mids = langIsEn ? ['then', 'after that', 'later'] : ['dann', 'danach', 'später'];
        const lead = i === 0 ? (langIsEn ? 'first' : 'zuerst') : i === own.length - 1 ? (langIsEn ? 'finally' : 'schliesslich') : mids[(i - 1) % mids.length];
        return `${lead}${w ? ' ' + w : ''} «${e.ereignis}»`;
      });
      const chainText = chain.slice(0, -1).join(', ') + (langIsEn ? ' and ' : ' und ') + chain[chain.length - 1];
      const answers = langIsEn
        ? [`In the chapter «${name}», ${f.name} goes through ${chainText}.`, `For ${f.name}, «${name}» is about ${joinList(own.map(item), true)}.`]
        : [`Im Kapitel «${name}» erlebt ${f.name} ${chainText}.`, `Für ${f.name} geht es in «${name}» um ${joinList(own.map(item), false)}.`];
      emitCard({ id: `chap:${name}:fig:${f.fig_id}`, kind: 'chapter', unit, core: true, subject: name, fields: { ...fields, figur: f.name } }, {
        task: 'chapterCore',
        questions: q.figure.map(t => fillCase(t.replace('{k}', name), f.name, decl)).filter(Boolean),
        answers, count: q.figure.length,
      });
    }
  }

  // Kapitelliste in Buchreihenfolge.
  if (chapters.length >= 2) {
    const list = joinList(chapters.map(c => `«${c}»`), langIsEn);
    const unit = 'book:chapters';
    const card = (id) => ({ id, kind: 'chapterList', unit, core: true, subject: displayName, fields: { kapitel: chapters } });
    emitCard(card('book:chapters'), {
      task: 'chapterCore', questions: q.list, count: q.list.length,
      answers: langIsEn
        ? [`«${displayName}» has ${chapters.length} chapters. In order, they are ${list}.`, `I have ${chapters.length} chapters: in order, ${list}.`, `My ${chapters.length} chapters, from first to last, are ${list}.`]
        : [`«${displayName}» hat ${chapters.length} Kapitel. Sie heissen der Reihe nach ${list}.`, `Ich habe ${chapters.length} Kapitel, der Reihe nach ${list}.`, `Meine ${chapters.length} Kapitel heissen von vorn bis hinten ${list}.`],
    });
    emitCard(card('book:chapters:first'), {
      task: 'chapterCore', questions: q.first,
      answers: langIsEn ? [`The first chapter is «${chapters[0]}».`, `The book begins with the chapter «${chapters[0]}».`]
        : [`Das erste Kapitel heisst «${chapters[0]}».`, `Das Buch beginnt mit dem Kapitel «${chapters[0]}».`],
    });
    emitCard(card('book:chapters:last'), {
      task: 'chapterCore', questions: q.last,
      answers: langIsEn ? [`The last chapter is «${chapters[chapters.length - 1]}».`, `The book ends with the chapter «${chapters[chapters.length - 1]}».`]
        : [`Das letzte Kapitel heisst «${chapters[chapters.length - 1]}».`, `Das Buch endet mit dem Kapitel «${chapters[chapters.length - 1]}».`],
    });
  }
}

module.exports = { buildEventCore, buildChapterCore, chapterOfEvent, chronicle, joinList, whenAdverb, EVENT_QUESTIONS: EQ, CHAPTER_QUESTIONS: CQ };

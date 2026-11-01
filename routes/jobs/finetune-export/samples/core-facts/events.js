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

// Zeitangabe als Adverbial: «im August 1998», «Ende August 1999», «1987».
// null, wenn sich keine sichere Form bilden lässt.
const MONTH_SEASON = /^(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|Frühling|Frühjahr|Sommer|Herbst|Winter|January|February|March|June|July|October|December|spring|summer|autumn|fall|winter)\b/i;
function whenAdverb(d, langIsEn) {
  const t = String(d || '').trim();
  if (!t || /^(unbekannt|unknown)$/i.test(t)) return null;
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
    chapter: ['Was passiert im Kapitel «{k}»?', 'Worum geht es im Kapitel «{k}»?', 'Was geschieht im Kapitel «{k}»?', 'Fasse das Kapitel «{k}» zusammen.'],
  },
  en: {
    when: ['When does «{e}» happen?', 'When does «{e}» take place?', 'At what time does «{e}» happen?'],
    who: ['Who is part of «{e}»?', 'Who is involved in «{e}»?', 'Which characters experience «{e}»?'],
    where: ['Where does «{e}» take place?', 'At which setting does «{e}» happen?', 'Where is «{e}» set?'],
    why: ['Why does «{e}» matter?', 'What is the significance of «{e}»?', 'What does «{e}» mean for the story?'],
    chapter: ['What happens in the chapter «{k}»?', 'What is the chapter «{k}» about?', 'What goes on in the chapter «{k}»?', 'Summarize the chapter «{k}».'],
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
    const inTitle = e.figs.filter(f => (f.names || [f.name]).some(n => n && nameRegex(n).test(E)));
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
      emitCard(card('why', { bedeutung: bed }), {
        task: 'eventCore', questions: q('why', E),
        answers: langIsEn
          ? [bed, `«${E}» matters because of this: ${bed}`]
          : [bed, `«${E}» ist für die Geschichte wichtig: ${bed}`],
      });
    }
  }
}

function buildChapterCore(ctx, emitCard) {
  const { langIsEn, events = [], chapterKeys = [], chapterNameByKey } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  // Kapitel in Lesereihenfolge; Ereignisse in Zeitstrahl-Reihenfolge.
  const order = new Map(chapterKeys.map((k, i) => [chapterNameByKey.get(k), i]));
  const byCh = new Map();
  for (const e of events) {
    for (const k of e.kapitel) {
      if (!byCh.has(k)) byCh.set(k, []);
      byCh.get(k).push(e);
    }
  }
  for (const [name, evs] of [...byCh].sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9))) {
    // Fünf Ereignisse über das ganze Kapitel verteilt, nicht die ersten fünf —
    // sonst bestünde der Inhalt eines langen Kapitels nur aus seinem Anfang.
    const top = evs.length <= 5 ? evs : [0, 1, 2, 3, 4].map(k => evs[Math.round(k * (evs.length - 1) / 4)]);
    const plain = top.map(e => e.ereignis);
    const dated = top.map(e => (e.datum ? `${e.datum}: ${e.ereignis}` : e.ereignis));
    const steps = top.map((e, i) => (i === 0 ? (langIsEn ? 'First' : 'Zuerst')
      : i === top.length - 1 ? (langIsEn ? 'Finally' : 'Schliesslich') : (langIsEn ? 'Then' : 'Dann')) + ': ' + e.ereignis + '.');
    // Kapitelinhalt ist Kernwissen: bleibt im Train und wird von der
    // Token-Mischung nicht gekürzt (wenige Karten, Leser fragen genau danach).
    emitCard({ id: 'chap:' + name, kind: 'chapter', unit: 'chap:' + name, core: true, subject: name,
      fields: { ereignisse: plain } }, {
      task: 'chapterCore',
      questions: EQ[lang].chapter.map(t => t.replace('{k}', name)),
      answers: langIsEn
        ? [`In the chapter «${name}»: ${plain.join('; ')}.`, `The chapter «${name}» by date: ${dated.join(' · ')}.`, `«${name}» tells this. ${steps.join(' ')}`]
        : [`Im Kapitel «${name}» geht es um: ${plain.join('; ')}.`, `Das Kapitel «${name}» in Daten: ${dated.join(' · ')}.`, `Das Kapitel «${name}» erzählt Folgendes. ${steps.join(' ')}`],
    });
  }
}

module.exports = { buildEventCore, buildChapterCore, joinList, whenAdverb, EVENT_QUESTIONS: EQ };

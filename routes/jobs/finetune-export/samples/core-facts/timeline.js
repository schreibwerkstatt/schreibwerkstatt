'use strict';

// Zeitstrahl rückwärts und quer (docs/finetuning.md#zeitstrahl-rückwärts): ein
// kleines LoRA, das «Stefan vergewaltigt Renate am Chilbi-Abend» nur in der
// Richtung Ereignis → Jahr gesehen hat, beantwortet die umgekehrte Frage
// meist nicht. Darum dieselben Fakten aus der anderen Richtung:
//   - Jahr → Ereignisse        «Was passiert 1999 in der Geschichte?»
//   - Figur + Jahr → Ereignisse «Was erlebt Renate 1999?»
//   - zwei Figuren → gemeinsame Ereignisse «Was erleben Stefan und Renate gemeinsam?»
//   - Reihenfolge zweier Ereignisse derselben Figur «Was passiert zuerst: …?»
// Unmittelbar davor/danach und die Ereigniskette stehen schon im Buchwissen
// (author-chat/events.js), «Wann erlebt X «E»?» in figures.js/core-set.js.
//
// Nur sichere Jahre (`unsure` aus), nur benannte Figuren. Was eine Figur
// «erlebt», sind ihre persönlichen Ereignisse — Weltgeschehen gehört nur in
// «Was passiert im Jahr …?». Jede Frage hat ihre eigene Antwort; Listen
// chronologisch, gedeckelt auf `LIST_MAX`.

const { hashSplit } = require('../../lib/names');
const { bestTier } = require('./relations');
const { declineName, isRoleName } = require('./naming');
const { joinList } = require('./events');

const LIST_MAX = 6;
const isWorld = (e) => String(e.typ || '').toLowerCase() === 'extern' || String(e.subtyp || '').toLowerCase().startsWith('extern');
const PAIR_MAX = 60;
const ORDER_PER_FIG = 4;

const T = {
  de: {
    year: ['Was passiert {y} in der Geschichte?', 'Was geschieht im Jahr {y}?', 'Welche Ereignisse fallen ins Jahr {y}?', 'Was ist {y} los?'],
    yearA: ['{y} passiert {list}.', 'Im Jahr {y} geschieht {list}.', 'In der Geschichte fällt ins Jahr {y}: {list}.'],
    figYear: ['Was erlebt {X} {y}?', 'Was passiert {y} mit {X:dat}?', 'Was geschieht im Jahr {y} in {Xg} Leben?'],
    figYearA: ['{y} erlebt {X} {list}.', 'Im Jahr {y} erlebt {X} {list}.', 'Für {X:akk} bringt das Jahr {y} {list}.'],
    pair: ['Was erleben {X} und {Y} gemeinsam?', 'Bei welchen Ereignissen sind {X} und {Y} beide dabei?', 'Welche Ereignisse verbinden {X:akk} und {Y:akk}?'],
    pairA: ['{X} und {Y} erleben gemeinsam {list}.', 'Gemeinsam dabei sind {X} und {Y} bei {list}.'],
    order: ['Was passiert zuerst: «{a}» oder «{b}»?', 'Kommt «{a}» vor oder nach «{b}»?', 'In welcher Reihenfolge geschehen «{a}» und «{b}»?'],
    orderA: ['Zuerst kommt «{first}» ({fy}), danach «{second}» ({sy}).', '«{first}» ({fy}) geschieht vor «{second}» ({sy}).'],
    more: (n) => ` und ${n} weitere`,
  },
  en: {
    year: ['What happens in {y} in the story?', 'What happens in the year {y}?', 'Which events fall in the year {y}?', 'What is going on in {y}?'],
    yearA: ['In {y}, {list} happens.', 'The year {y} brings {list}.', 'In the story, {y} is the year of {list}.'],
    figYear: ['What does {X} go through in {y}?', 'What happens to {X} in {y}?', "What happens in {Xg} life in {y}?"],
    figYearA: ['In {y}, {X} goes through {list}.', 'For {X}, the year {y} brings {list}.'],
    pair: ['What do {X} and {Y} experience together?', 'At which events are both {X} and {Y} present?', 'Which events connect {X} and {Y}?'],
    pairA: ['{X} and {Y} experience {list} together.', 'Both {X} and {Y} are part of {list}.'],
    order: ['What happens first: «{a}» or «{b}»?', 'Does «{a}» come before or after «{b}»?', 'In what order do «{a}» and «{b}» happen?'],
    orderA: ['First comes «{first}» ({fy}), then «{second}» ({sy}).', '«{first}» ({fy}) happens before «{second}» ({sy}).'],
    more: (n) => ` and ${n} more`,
  },
};

const genOf = (name, langIsEn) => (langIsEn ? (/s$/i.test(name) ? name + "'" : name + "'s")
  : (/(s|ß|x|z)$/i.test(name) ? name + "'" : name + 's'));

function fillT(tpl, v, langIsEn) {
  let missing = false;
  const out = tpl.replace(/\{(\w+)(?::(akk|dat))?\}/g, (_, k, kasus) => {
    if (k === 'Xg' || k === 'Yg') return genOf(v[k[0]], langIsEn);
    const val = v[k];
    if (val == null) { missing = true; return ''; }
    if (kasus && !langIsEn && (k === 'X' || k === 'Y')) return declineName(val, kasus) || val;
    return String(val);
  });
  return missing ? null : out.charAt(0).toUpperCase() + out.slice(1);
}

function eventsList(evs, langIsEn, L) {
  const shown = evs.slice(0, LIST_MAX).map(e => '«' + e.ereignis + '»');
  const rest = evs.length - shown.length;
  return rest > 0 ? shown.join(', ') + L.more(rest) : joinList(shown, langIsEn);
}

function buildTimelineReverse(ctx, emitCard) {
  const { langIsEn, events = [], opts } = ctx;
  const L = T[langIsEn ? 'en' : 'de'];
  const seed = opts?.valSeed || 0;
  const sure = events.filter(e => e.year && !e.unsure);
  const named = (f) => f.fig_id && !isRoleName(f.name) && !ctx.figNameInfo?.get(f.fig_id)?.ambiguous;
  const plain = (f) => String(f.name).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  let built = 0;
  const emit = (card, questions, answers) => {
    const qs = questions.filter(Boolean), as = answers.filter(Boolean);
    if (!qs.length || !as.length) return;
    built += emitCard(card, { task: 'eventTimeline', questions: qs, answers: as, count: qs.length });
  };

  // Jahr → Ereignisse
  const byYear = new Map();
  for (const e of sure) {
    if (!byYear.has(e.year)) byYear.set(e.year, []);
    byYear.get(e.year).push(e);
  }
  for (const [y, evs] of byYear) {
    const list = eventsList(evs, langIsEn, L);
    const figs = evs.flatMap(e => e.figs.filter(f => f.fig_id));
    emit({ id: `year:${y}`, kind: 'timeline', unit: `year:${y}`, tier: bestTier(ctx, figs), subject: String(y),
      fields: { jahr: y, ereignisse: evs.map(e => e.ereignis) } },
    L.year.map(t => fillT(t, { y }, langIsEn)), L.yearA.map(t => fillT(t, { y, list }, langIsEn)));
  }

  // Figur + Jahr → Ereignisse; Figur → Ereignisse (für Paare und Reihenfolge)
  const byFig = new Map();
  const orderSeen = new Set();
  for (const e of events) {
    if (isWorld(e)) continue;
    for (const f of e.figs) {
      if (!named(f)) continue;
      if (!byFig.has(f.fig_id)) byFig.set(f.fig_id, { f, evs: [] });
      byFig.get(f.fig_id).evs.push(e);
    }
  }
  for (const { f, evs } of byFig.values()) {
    const X = plain(f);
    const years = new Map();
    for (const e of evs) {
      if (!e.year || e.unsure) continue;
      if (!years.has(e.year)) years.set(e.year, []);
      years.get(e.year).push(e);
    }
    for (const [y, ys] of years) {
      const list = eventsList(ys, langIsEn, L);
      emit({ id: `fig:${f.fig_id}:year:${y}`, kind: 'timeline', unit: 'fig:' + f.fig_id, tier: bestTier(ctx, [f]),
        subject: X, fields: { figur: X, jahr: y, ereignisse: ys.map(e => e.ereignis) } },
      L.figYear.map(t => fillT(t, { X, y }, langIsEn)), L.figYearA.map(t => fillT(t, { X, y, list }, langIsEn)));
    }

    // Reihenfolge: Paare mit verschiedenen sicheren Jahren, wenige je Figur.
    const dated = evs.filter(e => e.year && !e.unsure);
    const pairs = [];
    for (let a = 0; a < dated.length; a++) {
      for (let b = a + 1; b < dated.length; b++) {
        if (dated[a].year !== dated[b].year) pairs.push([dated[a], dated[b]]);
      }
    }
    pairs.sort((p, q) => hashSplit(`ord|${f.fig_id}|${p[0].i}|${p[1].i}`, seed) - hashSplit(`ord|${f.fig_id}|${q[0].i}|${q[1].i}`, seed));
    let orders = 0;
    for (const [p, q] of pairs) {
      if (orders >= ORDER_PER_FIG) break;
      const [first, second] = p.year < q.year ? [p, q] : [q, p];
      const okey = first.i + '|' + second.i;
      if (orderSeen.has(okey)) continue;
      orderSeen.add(okey);
      orders++;
      const swap = hashSplit(`ordq|${p.i}|${q.i}`, seed) < 0.5;
      const [a, b] = swap ? [second, first] : [first, second];
      const v = { a: a.ereignis, b: b.ereignis, first: first.ereignis, second: second.ereignis, fy: first.year, sy: second.year };
      emit({ id: `order:${okey}`, kind: 'timeline', unit: 'fig:' + f.fig_id, tier: bestTier(ctx, [f]),
        subject: [first.ereignis, second.ereignis], fields: v },
      L.order.map(t => fillT(t, v, langIsEn)), L.orderA.map(t => fillT(t, v, langIsEn)));
    }
  }

  // Zwei Figuren → gemeinsame Ereignisse (die Paare mit den meisten zuerst)
  const pairMap = new Map();
  for (const e of events) {
    if (isWorld(e)) continue;
    const fs = [...new Map(e.figs.filter(named).map(f => [f.fig_id, f])).values()];
    for (let a = 0; a < fs.length; a++) {
      for (let b = a + 1; b < fs.length; b++) {
        const [A, B] = fs[a].fig_id < fs[b].fig_id ? [fs[a], fs[b]] : [fs[b], fs[a]];
        const key = A.fig_id + '|' + B.fig_id;
        if (!pairMap.has(key)) pairMap.set(key, { A, B, evs: [] });
        pairMap.get(key).evs.push(e);
      }
    }
  }
  const pairs = [...pairMap.entries()].filter(([, p]) => p.evs.length >= 2)
    .sort((a, b) => b[1].evs.length - a[1].evs.length || (a[0] < b[0] ? -1 : 1))
    .slice(0, PAIR_MAX);
  for (const [key, { A, B, evs }] of pairs) {
    const X = plain(A), Y = plain(B);
    const list = eventsList(evs, langIsEn, L);
    const qs = [...L.pair.map(t => fillT(t, { X, Y }, langIsEn)), ...L.pair.map(t => fillT(t, { X: Y, Y: X }, langIsEn))];
    emit({ id: `pairEvt:${key}`, kind: 'timeline', unit: 'rel:' + key, tier: bestTier(ctx, [A, B]),
      subject: [X, Y], fields: { figuren: [X, Y], ereignisse: evs.map(e => e.ereignis) } },
    qs, L.pairA.map(t => fillT(t, { X, Y, list }, langIsEn)));
  }

  ctx.eventTimelineCount = built;
  return built;
}

module.exports = { buildTimelineReverse };

'use strict';

const { leadSafe, eventList } = require('./event-data');

// Block 6-11: Zeitstrahl-Events. Die Ereignisse kommen angereichert aus
// ./event-data.js (Szenen, Schauplätze mit Bezug, Strang, Zeitspanne).
//
// Jede Frage hat eine eigene Antwort: keine Kreuzprodukte Figur × Ort ×
// Ereignis, die alle mit derselben Ereigniskarte antworten, und keine
// Facettenfrage, deren Antwort wieder die ganze Karte ist. Fragen zu einem
// Ereignis tragen `unit: evt:<i>` und wandern im Train/Val-Split gemeinsam;
// Sammellisten über mehrere Ereignisse bleiben ohne Einheit (nur Train).
//
// Orte stehen in den Fragen als «Schauplatz «X»» statt mit einer Präposition:
// ob «in Basel», «im Kantonsspital» oder «an der Aare», weiss der Export nicht.
function buildEventSamples(ctx) {
  const { langIsEn, events, locRows, eventQuestions, pushQA, pickVariants, PARAPHRASES } = ctx;
  const atLoc = (name) => (langIsEn ? `at ${name}` : `am Schauplatz «${name}»`);

  // ── Pro Ereignis ─────────────────────────────────────────────────────
  // Wann / Wer / Wo / Warum stehen als Kernwissen mit Varianten in
  // ../core-facts/events.js (gleiche Einheit `evt:<i>`).
  for (const e of events) {
    const { i, ereignis } = e;
    const unit = 'evt:' + i;
    for (const idx of pickVariants('evt|' + i, eventQuestions, PARAPHRASES)) {
      const q = eventQuestions[idx].replace('{ereignis}', ereignis);
      pushQA('authorChat|evt|' + i + '|' + idx, q, e.fullAnswer, { unit });
    }
    if (e.kapitel.length) {
      pushQA('authorChat|evt-ch|' + i,
        langIsEn ? `In which chapter does «${ereignis}» happen?` : `In welchem Kapitel passiert «${ereignis}»?`,
        langIsEn ? `«${ereignis}» happens in chapter ${e.kapitel.join(', ')}.` : `«${ereignis}» passiert im Kapitel ${e.kapitel.join(', ')}.`,
        { unit });
    }
    if (e.kindPhrase) {
      pushQA('authorChat|evt-typ|' + i,
        langIsEn ? `What kind of event is «${ereignis}»?` : `Was für ein Ereignis ist «${ereignis}»?`,
        langIsEn ? `«${ereignis}» is ${e.kindPhrase}.` : `«${ereignis}» ist ${e.kindPhrase}.`,
        { unit });
    }
  }

  // ── Sammellisten: Ereignisse pro Ort / Figur / Kapitel ───────────────
  const renderEvtList = (items, max = 8) => eventList(items.slice(0, max));
  const groupBy = (keyFn) => {
    const m = new Map();
    for (const e of events) {
      for (const [key, label] of keyFn(e)) {
        if (!m.has(key)) m.set(key, { label, items: [] });
        m.get(key).items.push(e);
      }
    }
    return m;
  };
  const figKey = (fg) => fg.fig_id || fg.name.toLowerCase();

  for (const [locPk, g] of groupBy(e => e.locs.map(l => [l.pk, l.name]))) {
    const loc = locRows.find(l => l.pk === locPk);
    if (!loc) continue;
    pushQA('authorChat|evtsByLoc|' + loc.loc_id,
      langIsEn ? `Which events take place ${atLoc(loc.name)}?` : `Welche Ereignisse spielen ${atLoc(loc.name)}?`,
      renderEvtList(g.items, 10));
  }
  for (const [fkey, g] of groupBy(e => e.figs.map(fg => [figKey(fg), fg.name]))) {
    pushQA('authorChat|evtsByFig|' + fkey,
      langIsEn ? `Which events involve ${g.label}?` : `An welchen Ereignissen ist ${g.label} beteiligt?`,
      renderEvtList(g.items, 10));
  }
  for (const [key, g] of groupBy(e => e.kapitel.map(ch => [ch.toLowerCase(), ch]))) {
    pushQA('authorChat|evtsByCh|' + key.replace(/\s+/g, '_').slice(0, 80),
      langIsEn ? `Which events take place in «${g.label}»?` : `Welche Ereignisse passieren in «${g.label}»?`,
      renderEvtList(g.items, 10));
  }

  // ── Weltgeschehen und persönliche Wendepunkte ────────────────────────
  const isExtern = (e) => (e.typ || '').toLowerCase() === 'extern';
  const externEvents = events.filter(isExtern);
  if (externEvents.length) {
    pushQA('authorChat|evtsExternAll',
      langIsEn ? `Which historical or global events appear in the book?` : `Welche historischen oder globalen Ereignisse spielen im Buch eine Rolle?`,
      eventList(externEvents.slice(0, 15), { meaning: false }));
    for (const [fkey, g] of groupBy(e => (isExtern(e) ? e.figs.map(fg => [figKey(fg), fg.name]) : []))) {
      pushQA('authorChat|evtsExtByFig|' + fkey,
        langIsEn ? `Which historical events touch ${g.label}'s life?` : `Welche historischen Ereignisse berühren ${g.label}s Leben?`,
        renderEvtList(g.items, 8));
    }
  }
  // Nur, wenn die Figur auch Weltgeschehen erlebt — sonst wäre die Liste
  // dieselbe wie «An welchen Ereignissen ist X beteiligt?».
  const externFigs = new Set(externEvents.flatMap(e => e.figs.map(figKey)));
  for (const [fkey, g] of groupBy(e => (!isExtern(e) ? e.figs.map(fg => [figKey(fg), fg.name]) : []))) {
    if (!externFigs.has(fkey)) continue;
    pushQA('authorChat|evtsPersByFig|' + fkey,
      langIsEn ? `What are ${g.label}'s personal turning points?` : `Was sind ${g.label}s persönliche Wendepunkte?`,
      renderEvtList(g.items, 8));
  }

  // ── Abfolge: was davor, was danach ───────────────────────────────────
  // sort_order spiegelt die erzählte Reihenfolge. Die Antwort nennt das
  // Nachbar-Ereignis, nicht dessen ganze Karte.
  const brief = (x) => leadSafe(x.ereignis) + (x.bedeutung ? ' — ' + x.bedeutung : '');
  // «Zuerst …, dann …, schliesslich ….» — ganze Sätze statt «1992: … → …».
  const chainSentence = (xs, en) => {
    const f = (x) => `«${x.ereignis}»${x.datum ? ` (${x.datum})` : ''}`;
    return en ? `First ${f(xs[0])}, then ${f(xs[1])}, finally ${f(xs[2])}.`
      : `Zuerst ${f(xs[0])}, dann ${f(xs[1])}, schliesslich ${f(xs[2])}.`;
  };
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    const unit = 'evt:' + e.i;
    if (k > 0) {
      pushQA('authorChat|evtCausePrev2|' + e.i,
        langIsEn ? `What happens just before «${e.ereignis}»?` : `Was geschieht unmittelbar vor «${e.ereignis}»?`,
        brief(events[k - 1]), { unit });
    }
    if (k + 1 < events.length) {
      pushQA('authorChat|evtCauseNext2|' + e.i,
        langIsEn ? `What happens right after «${e.ereignis}»?` : `Was geschieht direkt nach «${e.ereignis}»?`,
        brief(events[k + 1]), { unit });
    }
    if (k + 2 < events.length) {
      pushQA('authorChat|evtChain|' + e.i,
        langIsEn ? `Trace the chain of events starting from «${e.ereignis}».` : `Zeichne die Ereigniskette ab «${e.ereignis}» nach.`,
        chainSentence([e, events[k + 1], events[k + 2]], langIsEn),
        { unit });
    }
  }
  if (events.length >= 2) {
    pushQA('authorChat|evtChrono',
      langIsEn ? `List the events of the book in chronological order.` : `Liste die Ereignisse des Buches in chronologischer Reihenfolge.`,
      events.slice(0, 30).map((e, idx) => `${idx + 1}. ${e.datum ? e.datum + ': ' : ''}${e.ereignis}`).join('\n'));
  }

  // ── Figurenpaar: wann und wo ──────────────────────────────────────────
  // Nur für die ersten beiden Beteiligten und nur mit Datum oder einem Ort mit
  // Bezug. Mehr Paare wiederholten dieselbe Wann/Wo-Antwort. Bei erkennbaren
  // Ereignissen (Kuss/Hochzeit/Streit/…) zusätzlich die natürliche Frage.
  const verbalize = (ereignis) => {
    const t = (ereignis || '').toLowerCase();
    if (langIsEn) {
      if (/\bkiss/.test(t)) return 'kiss for the first time';
      if (/\b(meet|first met|first encounter)/.test(t)) return 'first meet';
      if (/\b(wedding|marri|got married)/.test(t)) return 'get married';
      if (/\b(fight|argu|quarrel)/.test(t)) return 'have a fight';
      if (/\b(break.?up|separat|split)/.test(t)) return 'break up';
      if (/\b(reuni|reunion)/.test(t)) return 'reunite';
      return null;
    }
    if (/\b(kuss|geküsst|küssen)/.test(t)) return 'sich das erste Mal geküsst';
    if (/\b(kennengelernt|kennenlern)/.test(t)) return 'sich kennengelernt';
    if (/\b(hochzeit|geheiratet|heirat)/.test(t)) return 'geheiratet';
    if (/\b(streit|gestritten)/.test(t)) return 'Streit gehabt';
    if (/\b(trennung|getrennt|trennen)/.test(t)) return 'sich getrennt';
    if (/\b(versöhn|wiedersehen|wiedergesehen)/.test(t)) return 'sich wiedergesehen';
    return null;
  };
  for (const e of events) {
    if (e.figs.length < 2) continue;
    const loc = e.locs[0]?.name || '';
    if (!e.datum && !loc) continue;
    const [A, B] = e.figs;
    const unit = 'evt:' + e.i;
    const parts = [];
    if (e.datum) parts.push(langIsEn ? `When: ${e.datum}.` : `Wann: ${e.datum}.`);
    if (loc) parts.push(langIsEn ? `Where: ${loc}.` : `Wo: ${loc}.`);
    const answer = `${e.ereignis}. ${parts.join(' ')}`;
    const pairKey = e.i + '|' + (A.fig_id || A.name) + '|' + (B.fig_id || B.name);
    pushQA('authorChat|evtPairWhen|' + pairKey,
      langIsEn ? `When and where do ${A.name} and ${B.name} meet in «${e.ereignis}»?`
        : `Wann und wo treffen ${A.name} und ${B.name} bei «${e.ereignis}» aufeinander?`,
      answer, { unit });
    const verb = verbalize(e.ereignis);
    if (verb) {
      pushQA('authorChat|evtPairVerbWhen|' + pairKey,
        langIsEn ? `When and where do ${A.name} and ${B.name} ${verb}?` : `Wann und wo haben ${A.name} und ${B.name} ${verb}?`,
        answer, { unit });
    }
  }
}

module.exports = { buildEventSamples };

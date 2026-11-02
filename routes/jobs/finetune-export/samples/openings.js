'use strict';

// Anfänge und Szenen als Schreibaufgabe (Familie writing, docs/finetuning.md#prosa):
//   - `chapterOpening`: echter Abschnitts- oder Szenenanfang des Buchs als Ziel
//     für «Schreibe den Anfang eines Abschnitts, in dem Hans und Stefan
//     aufeinandertreffen» bzw. «Beginne ein Kapitel über Stefan im Jahr 1996».
//     Das Eval prüft genau diese Bitte (`newChapter`); ohne Aufgabe dafür
//     antwortete das Modell mit einer Titelzeile in Schleife. Die genannten
//     Figuren stehen im Original-Anfang, das Jahr kommt aus einem Ereignis mit
//     sicherem Jahr, dessen Figur im Anfang vorkommt. Abschnitte sind in diesem
//     Datenmodell oft ein einziger Block ohne Leerzeile: der Anfang sind dann
//     die ersten Sätze bis OPENING_CHARS. Szenenanfang: die Buchstelle der
//     Szene (author-chat/scenes.js#sceneExcerpt), ab ihrem ersten Satz.
//   - `sceneBrief`: «Schreibe die Szene «…» aus Sicht von X» mit dem, was darin
//     geschieht, als Vorgabe → der Originaltext der Szene (gekürzt auf
//     `maxAnswerChars.sceneBrief`). Verbindet Faktenwissen mit Prosa.
// Beide stehen im Absatz-Budget vorn (lib/paragraph-budget.js); Train/Val
// trennt sie mit ihrem Abschnitt wie jeden Buchtext (lib/split.js).

const { clipAtSentence } = require('../lib/text');
const { nameRegex } = require('../lib/names');
const { sceneExcerpt } = require('./author-chat/scenes');
const { isRoleName } = require('./core-facts/naming');

const OPENING_CHARS = 1200;

const Q = {
  de: {
    pair: ['Schreibe den Anfang eines Abschnitts, in dem {a} und {b} aufeinandertreffen.', 'Beginne einen Abschnitt mit {a} und {b}.',
      'Wie könnte ein Abschnitt beginnen, in dem {a} und {b} vorkommen? Schreib ihn an.'],
    year: ['Beginne ein Kapitel über {a} im Jahr {y}.', 'Schreibe den Anfang eines Abschnitts über {a}, {y}.'],
    one: ['Schreibe den Anfang eines Abschnitts über {a}.', 'Beginne einen Abschnitt, in dem {a} im Mittelpunkt steht.'],
    scene: ['Schreibe den Anfang einer Szene mit {a} und {b}.', 'Beginne eine Szene, in der {a} auftritt.'],
    // Zusatz, der die Bitte eindeutig macht: dieselbe Bitte mit zwei
    // verschiedenen Anfängen lehrte Beliebigkeit (finalize.js#promptDedup).
    about: (k, e) => [k ? ` Er gehört zum Kapitel «${k}».` : '', e ? ` Es geht um «${e}».` : ''].join(''),
    brief: (t, x, what) => `Schreibe die Szene «${t}» aus Sicht von ${x}.${what ? ` Darin geschieht: ${what}.` : ''}`,
  },
  en: {
    pair: ['Write the beginning of a section in which {a} and {b} meet.', 'Begin a section with {a} and {b}.'],
    year: ['Begin a chapter about {a} in {y}.', 'Write the beginning of a section about {a}, {y}.'],
    one: ['Write the beginning of a section about {a}.'],
    scene: ['Write the beginning of a scene with {a} and {b}.', 'Begin a scene in which {a} appears.'],
    about: (k, e) => [k ? ` It belongs to the chapter «${k}».` : '', e ? ` It is about «${e}».` : ''].join(''),
    brief: (t, x, what) => `Write the scene «${t}» from ${x}'s point of view.${what ? ` In it: ${what}.` : ''}`,
  },
};
const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

function buildOpeningSamples(ctx) {
  const { samples, counts, unifiedSys, langIsEn, pageContents = [], figRows = [], sceneRows = [], opts } = ctx;
  const T = Q[langIsEn ? 'en' : 'de'];
  const seed = opts.valSeed || 0;
  const figs = figRows.filter(f => f.name && !isRoleName(f.name) && !ctx.figNameInfo?.get(f.fig_id)?.ambiguous && ctx.tierByFig?.get(f.fig_id) !== 'minor')
    .map(f => ({ f, name: ctx.figNameInfo?.get(f.fig_id)?.name || f.name, res: [f.name, f.kurzname].filter(n => n && n.length >= 3).map(n => nameRegex(n)) }));
  const present = (text) => figs.filter(x => x.res.some(re => re.test(text)));
  const push = (id, prompt, answer, page) => {
    samples.push({
      id, type: 'scene', sourceKey: 'ch:' + (page?.chapter_id ?? 0),
      messages: [{ role: 'system', content: unifiedSys }, { role: 'user', content: prompt }, { role: 'assistant', content: answer }],
    });
    counts.scene++;
  };
  const pick = (arr, i) => arr[(i + seed) % arr.length];
  // Sicheres Jahr eines Ereignisses dieses Abschnitts, dessen Figur im Anfang steht.
  const yearFor = (page, inOpening) => {
    const ids = new Set(inOpening.map(x => x.f.fig_id));
    const e = (ctx.events || []).find(ev => ev.year && !ev.unsure && (ev.pageIds || []).includes(page.id) && ev.figs.some(f => ids.has(f.fig_id)));
    return e ? { year: e.year, fig: inOpening.find(x => e.figs.some(f => f.fig_id === x.f.fig_id)) } : null;
  };
  const cap = Number(opts.maxAnswerChars?.chapterOpening) || OPENING_CHARS;
  let n = 0;
  pageContents.forEach((p, pi) => {
    const opening = clipAtSentence(String(p.text || '').trim(), Math.min(cap, OPENING_CHARS));
    if (opening.length < 300) return;
    const inOp = present(opening);
    if (!inOp.length) return;
    const prompts = [];
    if (inOp.length >= 2) prompts.push(fill(pick(T.pair, pi), { a: inOp[0].name, b: inOp[1].name }));
    const y = yearFor(p, inOp);
    if (y) prompts.push(fill(pick(T.year, pi), { a: y.fig.name, y: y.year }));
    if (!prompts.length) prompts.push(fill(pick(T.one, pi), { a: inOp[0].name }));
    const ev = (ctx.events || []).find(e => (e.pageIds || []).includes(p.id) && e.figs.some(f => inOp.some(x => x.f.fig_id === f.fig_id)));
    prompts.slice(0, 2).forEach((q, k) => {
      push(`chapterOpening|p${p.id}|${k}`, q + T.about(k ? '' : p.chapter, k ? ev?.ereignis : ''), opening, p);
      n++;
    });
  });
  // Szenenanfänge und Szenen aus Figurensicht.
  const pageOf = new Map(pageContents.map(p => [p.id, p]));
  const writeCap = Number(opts.maxAnswerChars?.sceneBrief) || opts.maxChars;
  let briefs = 0;
  sceneRows.forEach((s) => {
    if (!s.titel || !s.page_id) return;
    const ex = sceneExcerpt(s, { ...ctx, maxChars: Math.min(opts.maxChars, writeCap) });
    if (!ex) return;
    const page = pageOf.get(s.page_id);
    // Am Abschnittsanfang deckt der Abschnittsanfang oben die Szene schon.
    if (page && page.text.indexOf(ex.text) > 50) {
      const opening = clipAtSentence(ex.text, Math.min(cap, 900));
      const inOp = present(opening);
      if (opening.length >= 300 && inOp.length) {
        // Die Szene selbst, nicht ein Ereignis des Abschnitts: die Verknüpfung
        // läuft nur über den Abschnitt und träfe oft ein anderes Geschehen.
        const q = (inOp.length >= 2 ? fill(T.scene[0], { a: inOp[0].name, b: inOp[1].name }) : fill(T.scene[1], { a: inOp[0].name }))
          + T.about('', s.titel);
        push(`chapterOpening|s${s.id}`, q, opening, page); n++;
      }
    }
    const pov = present(ex.text).filter(x => ctx.tierByFig?.get(x.f.fig_id) === 'main').slice(0, 1);
    const what = [...new Set((ctx.eventsBySceneId?.get(s.id) || []).map(e => e.ereignis))].slice(0, 2).join('; ');
    for (const x of pov) { push(`sceneBrief|${s.id}|${x.f.fig_id}`, T.brief(s.titel, x.name, what), ex.text, page); briefs++; }
  });
  ctx.openingCount = n;
  ctx.sceneBriefCount = briefs;
}

module.exports = { buildOpeningSamples };

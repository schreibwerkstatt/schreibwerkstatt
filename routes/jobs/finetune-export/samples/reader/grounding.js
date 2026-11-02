'use strict';

// Wissen, was das Buch NICHT erzählt (docs/finetuning.md#ablehnen-lernen),
// und beim Nachhaken bei der Sache bleiben. Ohne diese Samples lernt das
// Modell: echter Name ⇒ es gibt eine Antwort; Ablehnungen kennt es nur für
// erfundene Namen. Und «Stimmt das wirklich?» beantwortet es mit der
// Ja-Vorlage — auch eine erfundene Antwort.
//
//   - buildNotInBookSamples (Task `notInBook`, Familie refusal):
//       · echte Haupt-/Nebenfigur × Eigenschaft, die weder Buchtext noch
//         Figurendaten nennen («Was ist Renates Lieblingsessen?»);
//       · echte Figurenpaare ohne Verbindung — keine Beziehung, auch nicht
//         über eine dritte Figur, kein gemeinsames Ereignis, nie im selben
//         Abschnitt — in den Beziehungsfragen des Kernwissens (Kontrast zu
//         relationCore);
//       · ein Teil davon mit Nachhaken («Komm schon, rate mal.»), auf das
//         das Modell nicht nachgibt.
//   - buildChallengeConversations (Task `factChallenge`, Familie facts):
//     eine belegte Antwort aus dem Set (Kernbeziehung, Ereignis-Zeitpunkt,
//     Beteiligung ja/nein, Richtigstellung einer falschen Annahme), dann
//     «Stimmt das wirklich?» / «Woher weisst du das?» → dabei bleiben, mit
//     Zeitpunkt und Kapitel, wo die Daten sie sicher hergeben. Gebaut aus
//     den fertigen Samples, mit deren Einheit (Train/Val bleibt getrennt).
//
// Ein Nachgeben auf Zweifel («Du hast recht, das stimmt nicht») gibt es
// bewusst nicht: die Antworten im Set sind belegt; das Modell soll eine
// richtige Antwort nicht aufgeben, nur weil der Leser zweifelt.

const { hashSplit, nameRegex } = require('../../lib/names');
const { QUESTIONS: REL_QUESTIONS, fillRelationQuestion } = require('../core-facts/relations');
const { genitive } = require('../core-facts/words');
const { whenAdverb } = require('../core-facts/events');
const { buildHaystack } = require('./refusals');
const { ATTRS, TEXT, LEADS } = require('./grounding-text');

const ATTRS_PER_TIER = { main: 3, side: 1 };
const PAIR_MAX = 30;
const INSIST_SHARE = 0.35;
const CHALLENGE_MAX = 300;

const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function namedFigures(ctx) {
  return (ctx.figRows || []).filter(f => {
    const info = ctx.figNameInfo?.get(f.fig_id);
    return f.name && info && info.proper !== false && !info.ambiguous
      && (!ctx.eligibleFigIds || ctx.eligibleFigIds.has(f.fig_id))
      && ATTRS_PER_TIER[ctx.tierByFig?.get(f.fig_id)];
  }).map(f => ({ ...f, name: ctx.figNameInfo.get(f.fig_id).name }));
}

const nameForms = (f) => {
  const all = [f.name, f.kurzname].filter(Boolean).map(n => String(n).replace(/\s*\([^)]*\)/g, '').trim());
  return [...new Set([...all, ...all.map(n => n.split(/\s+/)[0])])].filter(n => n.length >= 3);
};

function buildNotInBookSamples(ctx, push) {
  const { langIsEn, opts } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const t = TEXT[lang];
  const h = (key) => hashSplit(key, opts.valSeed);
  const pick = (arr, key) => arr[Math.floor(h(key) * arr.length)];
  const figs = namedFigures(ctx);
  if (!figs.length) return;

  // Eine erzählte Eigenschaft — irgendwo im Buch oder in den Figurendaten —
  // nimmt die Frage für alle Figuren aus dem Set: welche Figur gemeint ist,
  // lässt sich am Stichwort nicht sicher ablesen.
  const hay = buildHaystack(ctx) + '\n' + JSON.stringify(ctx.figRows || []).toLowerCase();
  const attrs = ATTRS[lang].filter(a => !a.kw.some(k => hay.includes(k)));
  const insist = (id, unit, turn, topic) => {
    if (h('ins|' + id) >= INSIST_SHARE) return;
    push({ id: id + '|insist', unit, turns: [turn, [pick(t.insistQ, 'insQ|' + id), fill(pick(t.insistA, 'insA|' + id), { topic })]] });
  };

  for (const f of figs) {
    const Xg = genitive(f.name, langIsEn);
    if (!Xg) continue;
    const n = ATTRS_PER_TIER[ctx.tierByFig.get(f.fig_id)];
    const chosen = [...attrs].sort((a, b) => h(`nib|${f.fig_id}|${a.key}`) - h(`nib|${f.fig_id}|${b.key}`)).slice(0, n);
    for (const a of chosen) {
      const v = { X: f.name, Xg, np: a.np };
      const id = `refusal|notInBook|attr|${f.fig_id}|${a.key}`;
      const unit = `ref:notInBook:${f.fig_id}`;
      const turn = [fill(pick(a.q, 'nibQ|' + id), v), fill(pick(t.attrA, 'nibA|' + id), v)];
      if (push({ id, unit, turns: [turn] })) insist(id, unit, turn, `${Xg} ${a.np}`);
    }
  }

  // Paare ohne Verbindung. Abstand im Beziehungsnetz ≤ 2 (Schwiegermutter,
  // Grossvater) zählt als verbunden, auch wenn das Netz die Kante nicht hat.
  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const r of ctx.relationFacts || []) { link(r.a.fig_id, r.b.fig_id); link(r.b.fig_id, r.a.fig_id); }
  const near = (a, b) => {
    const na = adj.get(a) || new Set();
    if (na.has(b)) return true;
    for (const x of na) if ((adj.get(x) || new Set()).has(b)) return true;
    return false;
  };
  const sharedEvent = new Set();
  for (const e of ctx.events || []) {
    const ids = e.figs.map(x => x.fig_id).filter(Boolean);
    for (const a of ids) for (const b of ids) sharedEvent.add(a + '|' + b);
  }
  const pagesOf = new Map(figs.map(f => {
    const res = nameForms(f).map(nameRegex);
    return [f.fig_id, new Set((ctx.pageContents || []).filter(p => res.some(re => re.test(p.text || ''))).map(p => p.id))];
  }));
  const pairs = [];
  for (let i = 0; i < figs.length; i++) {
    for (let j = i + 1; j < figs.length; j++) {
      const [a, b] = [figs[i], figs[j]];
      const pa = pagesOf.get(a.fig_id), pb = pagesOf.get(b.fig_id);
      if (!pa.size || !pb.size || [...pa].some(id => pb.has(id))) continue;
      if (near(a.fig_id, b.fig_id) || sharedEvent.has(a.fig_id + '|' + b.fig_id)) continue;
      const mains = [a, b].filter(x => ctx.tierByFig.get(x.fig_id) === 'main').length;
      pairs.push({ a, b, rank: -mains + h(`pair|${a.fig_id}|${b.fig_id}`) });
    }
  }
  pairs.sort((x, y) => x.rank - y.rank);
  for (const { a, b } of pairs.slice(0, PAIR_MAX)) {
    const key = `${a.fig_id}|${b.fig_id}`;
    const id = `refusal|notInBook|pair|${key}`;
    const [x, y] = h('pairDir|' + key) < 0.5 ? [a.name, b.name] : [b.name, a.name];
    const turn = [fillRelationQuestion(pick(REL_QUESTIONS[lang], 'pairQ|' + key), x, y, langIsEn),
      fill(pick(t.pairA, 'pairA|' + key), { a: x, b: y })];
    const unit = `ref:notInBook:pair:${key}`;
    if (push({ id, unit, form: 'relation', turns: [turn] })) {
      insist(id, unit, turn, langIsEn ? `a connection between ${x} and ${y}` : `eine Verbindung zwischen ${x} und ${y}`);
    }
  }
}

// Wiederholbarer Kern einer Antwort: ohne «Ja,»/«Nein,»/«Das stimmt so nicht:».
function restate(answer) {
  let s = String(answer || '').trim();
  for (const re of LEADS) s = s.replace(re, '');
  s = capFirst(s);
  return /^\p{Lu}/u.test(s) && s.length >= 12 ? s : null;
}

const CHALLENGE_FACT = /^(rel:|evt:\d+:(when|with:))/;

function buildChallengeConversations(ctx, push) {
  const { langIsEn, opts } = ctx;
  const t = TEXT[langIsEn ? 'en' : 'de'];
  const h = (key) => hashSplit(key, opts.valSeed);
  const pick = (arr, key) => arr[Math.floor(h(key) * arr.length)];
  const eventByI = new Map((ctx.events || []).map(e => [e.i, e]));

  // Je Karte eine Quelle (die erste Variante), nur Haupt- und Nebenfiguren;
  // dazu jede Richtigstellung einer falschen Annahme (eine je Einheit).
  const byCard = new Map();
  const fps = new Map();
  for (const s of ctx.samples) {
    if (s.messages?.length !== 3) continue;
    if (s.type === 'core' && CHALLENGE_FACT.test(s.factId || '') && ['main', 'side'].includes(s.tier)) {
      if (!byCard.has(s.factId)) byCard.set(s.factId, s);
    } else if (String(s.id).startsWith('refusal|falsePremise|') && !fps.has(s.unit)) {
      fps.set(s.unit, s);
    }
  }
  const core = [...byCard.values()].sort((a, b) => h('chg|' + a.id) - h('chg|' + b.id)).slice(0, CHALLENGE_MAX);

  for (const s of [...core, ...fps.values()]) {
    const [, q1, a1] = s.messages.map(m => m.content);
    const body = restate(a1);
    if (!body) continue;
    const asksSource = h('chgKind|' + s.id) < 0.4;
    let tail = '';
    const m = /^evt:(\d+):/.exec(s.factId || '');
    const e = m && eventByI.get(Number(m[1]));
    if (e) {
      const w = !e.unsure && whenAdverb(e.datum, langIsEn);
      if (w && !a1.includes(String(e.datum))) tail += fill(t.when, { w });
      if (asksSource && e.kapitel?.length === 1) tail += fill(t.chapter, { k: e.kapitel[0] });
    }
    const q2 = pick(asksSource ? t.sourceQ : t.doubtQ, 'chgQ|' + s.id);
    const lead = pick(asksSource ? t.sourceLead : t.doubtLead, 'chgL|' + s.id);
    push({
      id: `reader|challenge|${s.id}`, unit: s.unit, sourceKey: s.sourceKey,
      turns: [[q1, a1], [q2, lead + body + tail]],
    });
  }
}

module.exports = { buildNotInBookSamples, buildChallengeConversations, restate };

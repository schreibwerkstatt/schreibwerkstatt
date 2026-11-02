'use strict';

const { buildFactCategories, EVAL_QUESTIONS } = require('./eval/categories');
const { buildReaderEvalPrompts } = require('../samples/reader/eval');
const { validateEvalItem, touchesConflict } = require('./eval/criteria');
const { buildHaystack } = require('../samples/reader/refusals');

// Testprompts für den Vorher/Nachher-Vergleich (docs/finetuning.md §5) und den
// Vergleich mehrerer gesicherter Stände. Zeile:
//   { category, holdout, expected, mustContain, mustContainAny, mustNotContain,
//     judge, factIds, messages: [system, user] }
// Kriterien und ihre Bedeutung: lib/eval/criteria.js; Anleitung für den
// Richter: lib/eval/judge-md.js.
//
// Je Kategorie PER_CAT Fragen: die Hälfte in Frageformen, die im Train
// vorkommen (`holdout: false`, die Frage selbst nie wörtlich), die andere
// Hälfte in Formen, die das Train nicht kennt (`holdout: 'phrasing'`).
// `holdout: 'unit'` — der Fakt liegt in Val; `'text'` — der Buchtext liegt
// in Val (Fortsetzung). Fehlen Frageformen des Trains, füllt die andere
// Hälfte auf.
//
// Prüfungen: keine Frage wörtlich im Train (`trainPrompts`), keine Referenz,
// die einen gemeldeten Beziehungskonflikt wiederholt (lib/relation-check.js),
// jede Zeile mit mindestens einem aussagekräftigen Kriterium
// (`validateEvalItem`). Was durchfällt, steht in `ctx.evalDropped`.

const PER_CAT = 6;
// Mehr Fragen, wo eine Kategorie mehrere Formen prüft: Meta (Jahr, Kapitel,
// Werke, Entstehung …), Teil-Ablehnung mit Vergleich, Innenleben mit
// Kontrastfragen, Ich-Form für mehr Figuren, Warum für mehr Figuren,
// Falschannahmen auch in der Erzählform.
const PER_CAT_BY = { meta: 8, mixed: 8, psyche: 8, persona: 8, why: 8, falsePremise: 8 };

function buildEvalPrompts(ctx, { valUnits = new Set(), trainPrompts = null } = {}) {
  const { unifiedSys } = ctx;
  const out = [];
  const used = new Set();
  const dropped = { train: 0, conflict: 0, criterion: 0 };
  const hay = buildHaystack(ctx);
  const inBook = (name) => String(name).toLowerCase().split(/[\s-]+/).some(w => w.length >= 4 && hay.includes(w));
  const conflictPairs = [...(ctx.relationExcluded || [])].map(k => k.split('|')
    .map(id => ctx.figNameInfo?.get(id)?.name || ctx.figById?.get(id)?.name || id));
  const trainHas = (q) => !!trainPrompts?.has(String(q).trim());

  // Eine Zeile anlegen; false, wenn die Frage schon vergeben ist oder im Train steht.
  const add = (category, user, o = {}) => {
    const q = String(user || '').trim();
    if (!q || used.has(q)) return false;
    if (trainHas(q)) { dropped.train++; return false; }
    const item = {
      category, holdout: o.holdout ?? false, expected: o.expected || '',
      mustContain: (o.mustContain || []).filter(Boolean),
      mustContainAny: (o.mustContainAny || []).map(g => [...new Set(g.filter(Boolean))]).filter(g => g.length),
      mustNotContain: (o.mustNotContain || []).filter(Boolean),
      ...(Number.isInteger(o.minAny) ? { minAny: o.minAny } : {}),
      ...(o.maxOverlapWithProfile?.text ? { maxOverlapWithProfile: o.maxOverlapWithProfile } : {}),
      ...(o.style && Object.keys(o.style).length ? { style: o.style } : {}),
      judge: o.judge || '',
      factIds: o.factIds || [],
      messages: [{ role: 'system', content: unifiedSys }, { role: 'user', content: q }],
    };
    if (touchesConflict(item, conflictPairs)) { dropped.conflict++; return false; }
    if (validateEvalItem(item)) { dropped.criterion++; return false; }
    used.add(q);
    out.push(item);
    return true;
  };

  // Je Kategorie: die Hälfte aus `seen` (Frageformen des Trains), die Hälfte
  // aus `unseen`; Subjekte reihum, je Subjekt die erste freie Formulierung.
  const quota = (category, subjects, { seen, unseen, build, count }) => {
    if (!subjects.length) return;
    const total = count || PER_CAT_BY[category] || PER_CAT;
    const half = Math.ceil(total / 2);
    let n = 0;
    const run = (phase, max, gen) => {
      let got = 0;
      for (let round = 0; got < max && round < 4; round++) {
        for (let i = 0; got < max && i < subjects.length; i++) {
          const s = subjects[(i + round) % subjects.length];
          const qs = (gen(s) || []).filter(Boolean);
          const q = qs[(i + round + n) % Math.max(1, qs.length)];
          const pickQ = [q, ...qs].find(x => x && !used.has(x.trim()) && !trainHas(x));
          if (!pickQ) continue;
          const o = build(s, phase);
          const holdout = o.holdout === 'text' || o.holdout === 'unit' ? o.holdout : (phase === 'unseen' ? 'phrasing' : false);
          if (add(category, pickQ, { ...o, holdout })) { got++; n++; }
        }
      }
      return got;
    };
    const seenGot = run('seen', half, seen);
    run('unseen', total - seenGot, unseen);
  };

  const env = { quota, valUnits, trainHas, inBook };
  buildFactCategories(ctx, env);
  buildReaderEvalPrompts(ctx, env);
  ctx.evalDropped = dropped;
  return out;
}

module.exports = { buildEvalPrompts, EVAL_QUESTIONS, PER_CAT, PER_CAT_BY };

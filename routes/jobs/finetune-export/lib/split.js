'use strict';

const { hashSplit } = require('./names');

// Train/Val-Split nach Einheiten (docs/finetuning.md#trainval-split):
//   - Buchtext: Einheit ist der Abschnitt. Welche Abschnitte ein Sample
//     berührt, steht nicht im Sampler, sondern wird am Text erkannt (8-Wort-
//     Folgen aus Prompt und Antwort gegen den Abschnittstext; kurze Zitate per
//     Teilstring). So gilt die Regel auch für Sampler, die keinen Quellschlüssel
//     setzen, und für Kontext im Prompt. Berührt ein Sample Abschnitte aus
//     beiden Splits, fällt es weg.
//   - Fakten: Einheit ist die Entität bzw. Faktenkarte (`sample.unit`, z.B.
//     `evt:12`, `rel:fig_3|fig_7`), mit allen Fragen und Varianten dazu. Ohne
//     Einheit (Sammellisten, Kreuzfragen) nur Train.
//   - Kernwissen (`sample.core`: Grundfakten der Figuren) bleibt immer im
//     Train — Val hält nur übrige Fakten zurück.
// Val-Einheiten werden per Hash gereiht und als fester Anteil gezogen, nicht
// pro Einheit gewürfelt: bei 66 Abschnitten schwankte ein Münzwurf zu stark.

const NGRAM = 8;

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const normText = (s) => words(s).join(' ');

function pickValUnits(keys, share, seed) {
  const uniq = [...new Set(keys)];
  if (!(share > 0) || !uniq.length) return new Set();
  const n = Math.max(1, Math.round(uniq.length * share));
  if (n >= uniq.length) return new Set();
  return new Set(uniq
    .map(k => [hashSplit('val|' + k, seed), k])
    .sort((a, b) => a[0] - b[0])
    .slice(0, n)
    .map(([, k]) => k));
}

// Val-Abschnitte. Auch die Testprompts (lib/eval-prompts.js) fragen hiermit,
// welcher Text Holdout ist.
function valPageKeys(pageContents, opts) {
  return pickValUnits(pageContents.filter(p => p.text).map(p => 'p:' + p.id), opts.valSplit, opts.valSeed);
}

function buildPageIndex(pageContents) {
  const shingles = new Map();
  const normPages = [];
  for (const p of pageContents) {
    if (!p.text) continue;
    const key = 'p:' + p.id;
    const w = words(p.text);
    normPages.push([key, ' ' + w.join(' ') + ' ']);
    for (let i = 0; i + NGRAM <= w.length; i++) {
      const sh = w.slice(i, i + NGRAM).join(' ');
      const set = shingles.get(sh);
      if (set) set.add(key); else shingles.set(sh, new Set([key]));
    }
  }
  return { shingles, normPages };
}

// Kurze Zitate im Prompt («Wer sagt das: ‹…›?») erreichen die 8 Wörter nicht.
const QUOTED = /[«„“"‹]([^«»„“”"‹›\n]{20,400})[»“”"›]/g;

function pagesOfText(index, text, out) {
  const w = words(text);
  if (w.length >= NGRAM) {
    for (let i = 0; i + NGRAM <= w.length; i++) {
      const set = index.shingles.get(w.slice(i, i + NGRAM).join(' '));
      if (set) for (const k of set) out.add(k);
    }
    return;
  }
  const needle = w.join(' ');
  if (needle.length < 20) return;
  for (const [key, page] of index.normPages) if (page.includes(' ' + needle + ' ')) out.add(key);
}

function pagesOfSample(index, sample) {
  const out = new Set();
  for (const m of sample.messages) {
    if (m.role === 'system') continue;
    pagesOfText(index, m.content, out);
    if (m.role === 'user') for (const q of m.content.matchAll(QUOTED)) pagesOfText(index, q[1], out);
  }
  return out;
}

// → { train, val, mixed, valUnits } (Arrays der übergebenen Einträge `{ s, … }`).
function splitByUnits(entries, { pageContents, opts }) {
  const train = [], val = [], mixed = [];
  if (!(opts.valSplit > 0)) return { train: entries.slice(), val, mixed, valUnits: new Set() };
  const index = buildPageIndex(pageContents || []);
  const valPages = valPageKeys(pageContents || [], opts);
  const valEntities = pickValUnits(entries.filter(e => !e.s.core).map(e => e.s.unit).filter(Boolean), opts.valSplit, opts.valSeed);
  for (const e of entries) {
    if (e.s.core) { train.push(e); continue; }
    const pages = pagesOfSample(index, e.s);
    if (pages.size) {
      let inVal = 0;
      for (const k of pages) if (valPages.has(k)) inVal++;
      if (inVal === pages.size) val.push(e);
      else if (inVal === 0) train.push(e);
      else mixed.push(e);
    } else if (e.s.unit && valEntities.has(e.s.unit)) {
      val.push(e);
    } else {
      train.push(e);
    }
  }
  return { train, val, mixed, valUnits: valEntities };
}

const assistantTexts = (s) => s.messages.filter(m => m.role === 'assistant').map(m => normText(m.content));
const userText = (s) => s.messages.filter(m => m.role === 'user').map(m => normText(m.content)).join('\n');

function answerShingles(text, n = 12) {
  const w = text.split(' ');
  const out = [];
  for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
  return out;
}

// Überlappung Val ↔ Train: Prompt wörtlich, Antwort wörtlich, gemeinsame
// 12-Wort-Folge zwischen Antworten. Liefert die betroffenen Val-Samples je Art.
// Die Shingles werden nur für Val gebaut, Train wird dagegen gestreamt.
function valOverlap(trainSamples, valSamples) {
  const trainPrompts = new Set(trainSamples.map(userText));
  const trainAnswers = new Set(trainSamples.flatMap(assistantTexts));
  const prompt = new Set(), answer = new Set(), shingle = new Set();
  const shOwner = new Map();
  valSamples.forEach((s, i) => {
    if (trainPrompts.has(userText(s))) prompt.add(i);
    for (const a of assistantTexts(s)) {
      if (trainAnswers.has(a)) answer.add(i);
      for (const sh of answerShingles(a)) {
        if (!shOwner.has(sh)) shOwner.set(sh, []);
        shOwner.get(sh).push(i);
      }
    }
  });
  if (shOwner.size) {
    for (const s of trainSamples) {
      for (const a of assistantTexts(s)) {
        for (const sh of answerShingles(a)) {
          const owners = shOwner.get(sh);
          if (owners) for (const i of owners) shingle.add(i);
        }
      }
    }
  }
  return { prompt, answer, shingle };
}

module.exports = { splitByUnits, valOverlap, valPageKeys, pickValUnits, normText, pagesOfSample, buildPageIndex };

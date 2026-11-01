'use strict';

const { hashSplit } = require('./names');
const { splitParagraphs, chunkAtSentence } = require('./text');
const { familyOf } = require('./tasks');

// Derselbe Absatz soll nicht in vielen Aufgaben das Ziel sein (Fortsetzen,
// Szene schreiben, Lückentext, Wörtlich, Buchstelle …): jede weitere Kopie
// desselben Ziels belohnt Auswendiglernen statt Schreiben. Ein Sample «zielt»
// auf einen Absatz, wenn eine seiner Antworten eine 12-Wort-Folge mit ihm
// teilt. Höchstens `maxTargets` Samples pro Absatz bleiben (`maxTargetsPerParagraph`).
//
// Absatz = Absatz des Buchtexts; ein Block über PARA_MAX Zeichen (ganze
// Abschnitte ohne Leerzeile) zählt in Satzgrenzen-Stücken, sonst wäre ein
// ganzer Abschnitt ein einziger «Absatz» und trüge nur zwei Samples.

const SHINGLE = 12;
const PARA_MAX = 900;
const PARA_CHUNK = 800;

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function buildParagraphIndex(pageContents) {
  const shingles = new Map();
  let n = 0;
  for (const p of pageContents || []) {
    if (!p.text) continue;
    for (const para of splitParagraphs(p.text)) {
      const units = para.length > PARA_MAX ? chunkAtSentence(para, PARA_CHUNK) : [para];
      for (const u of units) {
        const id = n++;
        const w = words(u);
        for (let i = 0; i + SHINGLE <= w.length; i++) {
          const sh = w.slice(i, i + SHINGLE).join(' ');
          if (!shingles.has(sh)) shingles.set(sh, id);
        }
      }
    }
  }
  return { shingles };
}

function targetsOf(index, sample) {
  const out = new Set();
  for (const m of sample.messages) {
    if (m.role !== 'assistant') continue;
    const w = words(m.content);
    for (let i = 0; i + SHINGLE <= w.length; i++) {
      const id = index.shingles.get(w.slice(i, i + SHINGLE).join(' '));
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}

// Reihenfolge, in der Absätze vergeben werden: Fakten- und Leser-Samples mit
// Buchzitat zuerst (wenige, tragen Wissen), dann die Schreibaufgaben reihum —
// das k-te Sample jedes Typs vor dem (k+1)-ten, damit kein volumenstarker Typ
// (Fortsetzen) alle Absätze belegt. Verbatim zuletzt.
const WRITING_PRIORITY = ['sceneWrite', 'continue', 'passage', 'povPassage', 'dialogLine', 'transition', 'cloze', 'reversePrompt', 'verbatim'];

function applyParagraphBudget(entries, { pageContents, maxTargets, seed = 0 }) {
  if (!(maxTargets > 0)) return { kept: entries, dropped: 0 };
  const index = buildParagraphIndex(pageContents);
  const withT = entries.map(e => ({ e, t: targetsOf(index, e.s) }));
  const rankInTask = new Map();
  const byTask = new Map();
  for (const x of withT) {
    if (!x.t.size) continue;
    if (!byTask.has(x.e.s.task)) byTask.set(x.e.s.task, []);
    byTask.get(x.e.s.task).push(x);
  }
  for (const arr of byTask.values()) {
    arr.sort((a, b) => hashSplit('par|' + a.e.s.id, seed) - hashSplit('par|' + b.e.s.id, seed));
    arr.forEach((x, i) => rankInTask.set(x, i));
  }
  const prio = (task) => {
    if (familyOf(task) !== 'writing') return -1;
    const i = WRITING_PRIORITY.indexOf(task);
    return i < 0 ? WRITING_PRIORITY.length : i;
  };
  const ordered = withT.filter(x => x.t.size).sort((a, b) =>
    (prio(a.e.s.task) < 0 ? -1 : 0) - (prio(b.e.s.task) < 0 ? -1 : 0)
    || (a.e.s.task === 'verbatim') - (b.e.s.task === 'verbatim')
    || rankInTask.get(a) - rankInTask.get(b)
    || prio(a.e.s.task) - prio(b.e.s.task));
  const used = new Map();
  const keep = new Set(withT.filter(x => !x.t.size).map(x => x.e));
  for (const x of ordered) {
    if ([...x.t].some(id => (used.get(id) || 0) >= maxTargets)) continue;
    for (const id of x.t) used.set(id, (used.get(id) || 0) + 1);
    keep.add(x.e);
  }
  const kept = entries.filter(e => keep.has(e));
  return { kept, dropped: entries.length - kept.length };
}

// Grösste Zahl von Samples, die denselben Absatz als Ziel haben (Statistik).
function paragraphTargetMax(samples, pageContents) {
  const index = buildParagraphIndex(pageContents);
  const used = new Map();
  let max = 0;
  for (const s of samples) {
    for (const id of targetsOf(index, s)) {
      const n = (used.get(id) || 0) + 1;
      used.set(id, n);
      if (n > max) max = n;
    }
  }
  return max;
}

module.exports = { applyParagraphBudget, paragraphTargetMax, buildParagraphIndex, targetsOf };

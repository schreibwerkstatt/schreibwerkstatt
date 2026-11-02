'use strict';

const { splitSentences } = require('./text');
const { hashSplit } = require('./names');

// `blockReuse` (finalize.js): kein Satz über BLOCK_MIN Zeichen steht in mehr
// als BLOCK_MAX Antworten wörtlich. Ein langer Satz, den das Modell in
// hunderten Antworten sieht (der erste Satz eines Figurenprofils), wird zum
// Attraktor: es legt ihn auf jede Warum- und Innenleben-Frage, auch zu anderen
// Figuren. Buchtext-Ziele (Familie writing) zählen nicht — dort deckelt das
// Absatz-Budget.
//
// Statt das ganze Beispiel zu verwerfen, fällt ab dem (BLOCK_MAX+1)-ten
// Vorkommen nur der Satz aus der Antwort: ein Porträt ohne seinen
// Wendepunkt-Satz, eine Beziehung ohne den Beschreibungssatz bleibt ein
// richtiges Beispiel mit dem Kernfakt. Bleibt in einem Antwortzug weniger als
// MIN_LEFT Zeichen übrig, fällt das Beispiel weg. Reihenfolge: geschützte
// Beispiele (`isProtected`) und Kernwissen zuerst, sonst per Hash — sie
// behalten den vollen Text.
const BLOCK_MIN = 80;
const BLOCK_MAX = 5;
const MIN_LEFT = 20;
// Deutungen ohne ihren Kern sind keine Antwort mehr: dort muss mehr übrig bleiben.
const MIN_LEFT_BY_TASK = { eventWhy: 120, sceneWhy: 160, psyche: 60 };

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const longSentences = (text) => splitSentences(String(text || '')).map(norm).filter(s => s.length > BLOCK_MIN);

// `entries`: `{ s, family }` aus finalize.js. → { kept, trimmed, dropped }.
function applyBlockReuse(entries, { isProtected = () => false, seed = 0, max = BLOCK_MAX } = {}) {
  const rank = (e) => (isProtected(e.s) ? 0 : e.s.core ? 1 : 2);
  const order = [...entries].filter(e => e.family !== 'writing')
    .sort((a, b) => rank(a) - rank(b) || hashSplit('blk|' + a.s.id, seed) - hashSplit('blk|' + b.s.id, seed));
  const count = new Map();
  const drop = new Set();
  let trimmed = 0;
  for (const e of order) {
    const plans = [];
    let ok = true;
    for (const m of e.s.messages) {
      if (m.role !== 'assistant') continue;
      const parts = splitSentences(m.content).map(norm).filter(Boolean);
      const keep = parts.filter(p => p.length <= BLOCK_MIN || (count.get(p) || 0) < max);
      if (keep.length === parts.length) { plans.push(null); continue; }
      const text = keep.join(' ');
      if (text.length < (MIN_LEFT_BY_TASK[e.s.task] || MIN_LEFT)) { ok = false; break; }
      plans.push(text);
    }
    if (!ok) { drop.add(e); continue; }
    let i = 0;
    let changed = false;
    for (const m of e.s.messages) {
      if (m.role !== 'assistant') continue;
      const p = plans[i++];
      if (p !== null) { m.content = p; changed = true; }
      for (const s of longSentences(m.content)) count.set(s, (count.get(s) || 0) + 1);
    }
    if (changed) trimmed++;
  }
  return { kept: entries.filter(e => !drop.has(e)), trimmed, dropped: drop.size };
}

// Grösste Wiederholung eines langen Satzes über Antworten (Statistik).
// `skip(sample)`: Beispiele, die nicht zählen (Buchtext-Ziele).
function maxBlockReuse(samples, skip = () => false) {
  const count = new Map();
  for (const s of samples) {
    if (skip(s)) continue;
    const seen = new Set();
    for (const m of s.messages) if (m.role === 'assistant') for (const t of longSentences(m.content)) seen.add(t);
    for (const t of seen) count.set(t, (count.get(t) || 0) + 1);
  }
  let max = 0, text = '';
  for (const [t, n] of count) if (n > max) { max = n; text = t; }
  return { max, text: text.length > 140 ? text.slice(0, 140) + '…' : text };
}

module.exports = { applyBlockReuse, maxBlockReuse, BLOCK_MIN, BLOCK_MAX };

'use strict';

const { hashSplit } = require('./names');
const { estimateTokens } = require('./tokens');

// Mischung des Sets nach ANTWORT-Tokens statt nach Anzahl. Eine Schreibaufgabe
// trägt rund zehnmal so viele Antwort-Tokens wie eine Faktenfrage — nach Anzahl
// gezählt stellte die Prosa 60 % der Beispiele, aber über 90 % des Loss.
//
// Zielanteile (`familyTokenShares`, Profil): writing / facts / persona. Weil
// nur weggelassen, nie ergänzt werden kann, gilt:
//   1. writing und facts im Verhältnis ihrer Zielanteile — die grössere Seite
//      wird gekürzt;
//   2. persona höchstens ihr Anteil an (writing + facts), sonst gekürzt — zu
//      wenig Persona bleibt zu wenig, sie zieht die anderen nicht mit;
//   3. verbatim höchstens `verbatimMaxTokenShare` aller Antwort-Tokens;
//   4. refusal nach ANZAHL (`refusalShare` der Beispiele, verteilt nach
//      `refusalMix`): Ablehnungen sind kurz, 5 % der Tokens wären ein Viertel
//      aller Beispiele.
// Gekürzt wird jeder Aufgabentyp anteilig (das letzte Zehntel jedes Typs vor
// dem vorletzten), damit kleine Typen (Welt-Fakten, Songs, «Wer sagt das?»)
// nicht ganz wegfallen; innerhalb eines Typs fallen Sammellisten ohne Einheit
// vor Einzelfragen.
//
// Fakten werden nach WICHTIGKEIT gekürzt (`factRank`): zuerst Fakten zu
// Randfiguren, dann Orte/Welt/Szenen, dann übrige Fakten, dann
// Zusatzvarianten des Kernwissens der Rand-, zuletzt der Nebenfiguren. Nie
// gekürzt (`isProtected`): das ganze Kernwissen der Hauptfiguren, der
// Kapitelinhalt und die erste Variante jeder Kernkarte (und Fragerichtung) —
// so bleibt jede Kernkarte im Set (`coreFactCoverage`), und lieber fallen
// Randfiguren-Fakten ganz weg, als dass eine Hauptfigur auf eine Variante
// schrumpft. Die Bedeutung (`tier`: main/side/minor) trägt das Sample selbst
// (core-facts) oder ergibt sich aus den Figuren-IDs in seiner ID (`tierByFig`).

const answerTokens = (s, langIsEn) => s.messages
  .filter(m => m.role === 'assistant')
  .reduce((a, m) => a + estimateTokens(m.content, langIsEn), 0);

function sumTokens(list) { return list.reduce((a, e) => a + e.answerTokens, 0); }

const TIER_RANK = { main: 0, side: 1, minor: 2 };
const LOW_PRIORITY_FACTS = new Set(['factPlace', 'factWorld', 'factScene']);

// Variante einer Kernkarte: letzte Stelle der ID (`core|<karte>[|dir]|<n>`).
const variantOf = (s) => (s.type === 'core' ? Number(String(s.id).split('|').pop()) || 0 : 0);

// Bedeutung eines Samples: eigenes `tier`, sonst die wichtigste Figur, deren
// ID im Sample steckt (`authorChat|figTraits|fig_12`). null ohne Figur.
function tierOf(s, tierByFig) {
  if (s.tier) return s.tier;
  if (!tierByFig) return null;
  let best = null;
  for (const id of String(s.id).match(/\bfig_\d+\b/g) || []) {
    const t = tierByFig.get(id);
    if (t && (best === null || TIER_RANK[t] < TIER_RANK[best])) best = t;
  }
  return best;
}

function isProtected(s) {
  if (!s.core) return false;
  return s.task === 'chapterCore' || s.tier === 'main' || variantOf(s) === 0;
}

// Kürz-Rang eines Fakten-Samples, kleiner fällt zuerst: Randfiguren →
// Orte/Welt/Szenen → übrige → Zusatzvarianten Kernwissen Rand-/Nebenfiguren
// → Fakten der Hauptfiguren (Ereignis-Facetten, Buchwissen).
function factRank(s, tierByFig) {
  const tier = tierOf(s, tierByFig);
  if (s.core) return tier === 'main' ? 5 : tier === 'side' ? 4 : 3;
  if (tier === 'minor') return 0;
  if (LOW_PRIORITY_FACTS.has(s.task)) return 1;
  if (tier === 'main') return 5;
  return 2;
}

// Entfernt aus `list` (Drop-Reihenfolge `dropOrder`) so lange, bis die Summe
// ≤ budget ist. Geschützte Einträge bleiben. → Set der entfernten Einträge.
function trimTo(list, budget, dropOrder) {
  const out = new Set();
  let sum = sumTokens(list);
  for (const e of [...list].sort(dropOrder)) {
    if (sum <= budget) break;
    if (isProtected(e.s)) continue;
    out.add(e);
    sum -= e.answerTokens;
  }
  return out;
}

// Drop-Reihenfolge: anteilig über die Aufgabentypen. Pro Typ eine Rangfolge
// (bevorzugt zuerst), dann nach relativem Rang absteigend — das hinterste
// Stück jedes Typs fällt zuerst. `first` (optional) fällt vor allem anderen.
function proportionalDropOrder(list, h, tag, first = () => false) {
  const byTask = new Map();
  for (const e of list) {
    if (!byTask.has(e.s.task)) byTask.set(e.s.task, []);
    byTask.get(e.s.task).push(e);
  }
  const rel = new Map();
  for (const arr of byTask.values()) {
    arr.sort((a, b) => (a.s.unit ? 0 : 1) - (b.s.unit ? 0 : 1) || h(a, tag) - h(b, tag));
    arr.forEach((e, i) => rel.set(e, (i + 1) / arr.length));
  }
  return (a, b) => (first(b) ? 1 : 0) - (first(a) ? 1 : 0) || rel.get(b) - rel.get(a) || h(a, tag) - h(b, tag);
}

function mixByTokens(entries, opts) {
  const { langIsEn, seed = 0 } = opts;
  const shares = opts.familyTokenShares || {};
  const sw = Number(shares.writing) || 0, sf = Number(shares.facts) || 0, sp = Number(shares.persona) || 0;
  for (const e of entries) e.answerTokens = answerTokens(e.s, langIsEn);
  const h = (e, tag) => hashSplit(tag + '|' + e.s.id, seed);
  const byFam = (f) => entries.filter(e => e.family === f);
  const drop = new Set();
  const dropped = { writing: 0, facts: 0, persona: 0, verbatim: 0, refusal: 0 };

  // 1. writing ↔ facts
  if (sw > 0 && sf > 0) {
    const W = sumTokens(byFam('writing'));
    const F = sumTokens(byFam('facts'));
    if (W > F * sw / sf) {
      const list = byFam('writing');
      const order = proportionalDropOrder(list, h, 'mixW', (e) => e.s.task === 'verbatim');
      for (const e of trimTo(list, F * sw / sf, order)) { drop.add(e); dropped.writing++; }
    } else if (F > W * sf / sw) {
      // Geschütztes Kernwissen zählt mit, wird aber nie gekürzt (trimTo
      // überspringt es); sonst nach Wichtigkeit, innerhalb eines Rangs anteilig
      // je Typ, Kernkarten von der höchsten Variante abwärts.
      const list = byFam('facts');
      const rank = new Map(list.map(e => [e, factRank(e.s, opts.tierByFig)]));
      const prop = proportionalDropOrder(list, h, 'mixF');
      const order = (a, b) => rank.get(a) - rank.get(b) || variantOf(b.s) - variantOf(a.s) || prop(a, b);
      for (const e of trimTo(list, W * sf / sw, order)) { drop.add(e); dropped.facts++; }
    }
  }
  const live = (f) => byFam(f).filter(e => !drop.has(e));

  // 2. persona
  if (sp > 0 && sw + sf > 0) {
    const budget = sp / (sw + sf) * (sumTokens(live('writing')) + sumTokens(live('facts')));
    const list = live('persona');
    for (const e of trimTo(list, budget, proportionalDropOrder(list, h, 'mixP'))) { drop.add(e); dropped.persona++; }
  }

  // 3. verbatim
  const vShare = Number(opts.verbatimMaxTokenShare);
  if (vShare >= 0 && Number.isFinite(vShare)) {
    const total = sumTokens(entries.filter(e => !drop.has(e)));
    const verb = live('writing').filter(e => e.s.task === 'verbatim');
    const order = (a, b) => h(a, 'mixV') - h(b, 'mixV');
    for (const e of trimTo(verb, vShare * total, order)) { drop.add(e); dropped.verbatim++; }
  }

  // 4. refusal nach Anzahl
  const refusalCount = {};
  const rShare = Number(opts.refusalShare);
  const refusals = live('refusal');
  if (rShare >= 0 && rShare < 1) {
    const others = entries.filter(e => !drop.has(e) && e.family !== 'refusal').length;
    const target = Math.round(others * rShare / (1 - rShare));
    const mix = opts.refusalMix || {};
    const bySub = new Map();
    for (const e of refusals) {
      if (!bySub.has(e.s.task)) bySub.set(e.s.task, []);
      bySub.get(e.s.task).push(e);
    }
    const weights = [...bySub.keys()].map(k => [k, Number(mix[k]) || 0]);
    const wSum = weights.reduce((a, [, w]) => a + w, 0) || 1;
    // Quote pro Untertyp; was ein Untertyp nicht füllen kann, geht reihum an die anderen.
    const quota = new Map(weights.map(([k, w]) => [k, Math.round(target * w / wSum)]));
    let spare = 0;
    for (const [k, arr] of bySub) {
      const q = quota.get(k);
      if (arr.length < q) { spare += q - arr.length; quota.set(k, arr.length); }
    }
    for (const [k, arr] of bySub) {
      if (spare <= 0) break;
      const add = Math.min(spare, arr.length - quota.get(k));
      quota.set(k, quota.get(k) + add);
      spare -= add;
    }
    for (const [k, arr] of bySub) {
      const sorted = [...arr].sort((a, b) => h(a, 'mixR') - h(b, 'mixR'));
      for (const e of sorted.slice(quota.get(k))) { drop.add(e); dropped.refusal++; }
      refusalCount[k] = Math.min(arr.length, quota.get(k));
    }
  }

  return { kept: entries.filter(e => !drop.has(e)), dropped, refusalCount };
}

module.exports = { mixByTokens, answerTokens, tierOf, isProtected, factRank };

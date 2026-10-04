'use strict';
// Figuren-Idiolekt: Wortschatz der wörtlichen Rede je Figur. Pure — die
// Dialog-Erkennung und die Namensmuster kommen injiziert aus lib/page-index.js
// (`findDialogRanges`, `buildFigureNamePatterns`), damit hier dieselbe Regel gilt
// wie in Stil-Metriken und Figuren-Erwähnungen, ohne dass dieses Modul die DB lädt.
//
// Sprecherzuordnung — bewusst VORSICHTIG:
//   Ein Absatz (Block) mit wörtlicher Rede wird einer Figur nur dann zugeordnet,
//   wenn im ERZÄHLTEXT desselben Absatzes (alles ausserhalb der Rede) genau EINE
//   Figur genannt wird: „»Komm jetzt«, sagte Anna." Steht keine oder mehr als eine
//   Figur im Erzähltext, bleibt die Rede unzugeordnet. Lieber weniger Rede pro
//   Figur als falsch zugeordnete — ein falsch zugeordneter Satz macht aus zwei
//   Stimmen eine. Wie viel Rede insgesamt zugeordnet werden konnte, geht als
//   `coverage` mit hinaus; die Karte zeigt es, sonst liest sich der Ausschnitt als
//   Vollständigkeit.
//   Folge der Regel: ein Ich-Erzähler („sagte ich") und Wechselrede ohne
//   Inquit-Formel bleiben unzugeordnet.
//
// Typische Wörter: Keyness (G², vorzeichenbehaftet) der Rede einer Figur gegen die
// Rede ALLER ANDEREN Figuren — nicht gegen das Buch. Gefragt ist „wie spricht
// Anna anders als die anderen", nicht „wie unterscheidet sich Dialog von Erzählung".

const measures = require('./measures');
const { tokenize, frequencies } = require('./tokenize');
const { keynessFor } = require('./keyness');
const { round } = require('./round');

// Unter dieser Redemenge sind Diversitätswerte Rauschen; die Figur bekommt dann
// keine Zeile.
const IDIOLECT_MIN_TOKENS = 150;
const IDIOLECT_TERM_LIMIT = 12;

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Namensmuster je Figur als Regex mit Unicode-Wortgrenzen. Figuren mit gleichem
// Namen (Kopien desselben Stammeintrags unter verschiedenen Konten) bilden EINE
// Gruppe — sonst hätte jeder Absatz mit „Anna" zwei Kandidaten und fiele weg.
function _figureGroups(figures, buildPatterns) {
  const byKey = new Map();
  for (const f of figures || []) {
    const key = String(f.name || '').trim().toLowerCase();
    if (!key) continue;
    let g = byKey.get(key);
    if (!g) {
      const pats = buildPatterns(f.name, f.kurzname).map(p => _escapeRegex(p.text));
      if (!pats.length) continue;
      g = { key, ids: [], re: new RegExp(`(?<![\\p{L}\\p{M}])(?:${pats.join('|')})(?![\\p{L}\\p{M}])`, 'iu') };
      byKey.set(key, g);
    }
    g.ids.push(f.id);
  }
  return [...byKey.values()];
}

// blocks: string[] (Absatztexte in Leserichtung, wie analyze.js#blockTextsFromHtml)
// figures: [{ id, name, kurzname }]
// deps: { findDialogRanges(text) → [[start,end]], buildFigureNamePatterns(name, kurz) }
// isTermCandidate(term) → bool (dieselbe Filterregel wie die Lieblingswörter)
function analyzeIdiolect(blocks, figures, deps, { isTermCandidate } = {}) {
  const groups = _figureGroups(figures, deps.buildFigureNamePatterns);
  const perGroup = new Map(groups.map(g => [g, { tokens: [], utterances: 0 }]));
  let dialogTokens = 0;
  let attributedTokens = 0;

  for (const text of blocks || []) {
    const ranges = deps.findDialogRanges(text);
    if (!ranges.length) continue;
    // Erzähltext = Absatz ohne die Rede (gleiche Länge, Rede durch Leerzeichen
    // ersetzt), damit ein Name IN der Rede („»Anna, komm!«") nicht als Sprecher gilt.
    let narr = '';
    let pos = 0;
    const speech = [];
    for (const [a, b] of ranges) {
      narr += text.slice(pos, a) + ' '.repeat(Math.max(0, b - a));
      speech.push(text.slice(a, b));
      pos = b;
    }
    narr += text.slice(pos);

    const toks = speech.map(s => tokenize(s));
    const n = toks.reduce((s, t) => s + t.length, 0);
    dialogTokens += n;
    if (!n) continue;

    const hits = groups.filter(g => g.re.test(narr));
    if (hits.length !== 1) continue;
    const acc = perGroup.get(hits[0]);
    for (const t of toks) {
      if (!t.length) continue;
      acc.utterances++;
      for (const w of t) acc.tokens.push(w);
    }
    attributedTokens += n;
  }

  const active = groups.filter(g => perGroup.get(g).tokens.length >= IDIOLECT_MIN_TOKENS);
  const freqs = new Map(active.map(g => [g, frequencies(perGroup.get(g).tokens)]));
  // Gesamtfrequenz der zugeordneten Rede — Referenz für eine Figur ist der Rest.
  const allFreq = new Map();
  let allTotal = 0;
  for (const g of active) {
    for (const [t, c] of freqs.get(g)) allFreq.set(t, (allFreq.get(t) || 0) + c);
    allTotal += perGroup.get(g).tokens.length;
  }

  const rows = [];
  for (const g of active) {
    const acc = perGroup.get(g);
    const freq = freqs.get(g);
    const total = acc.tokens.length;
    const hx = measures.hapaxStats(freq);
    const m = measures.mattr(acc.tokens);

    let terms = [];
    const restTotal = allTotal - total;
    if (restTotal > 0) {
      const restFreq = new Map();
      for (const [t, c] of allFreq) {
        const rest = c - (freq.get(t) || 0);
        if (rest > 0) restFreq.set(t, rest);
      }
      const cands = [...freq.keys()].filter(t => !isTermCandidate || isTermCandidate(t));
      const key = keynessFor(cands, freq, restFreq, total, restTotal);
      terms = cands
        .map(t => ({ term: t, count: freq.get(t), keyness: key.get(t) }))
        .filter(r => r.keyness != null && r.keyness > 0)
        .sort((a, b) => b.keyness - a.keyness || b.count - a.count || (a.term < b.term ? -1 : 1))
        .slice(0, IDIOLECT_TERM_LIMIT);
    }

    const row = {
      utterances: acc.utterances,
      tokens: total,
      types: hx.types,
      mattr: m.value,
      mattr_window: m.window,
      mtld: measures.mtld(acc.tokens),
      avg_utterance_len: acc.utterances ? round(total / acc.utterances, 1) : null,
      terms,
    };
    for (const id of g.ids) rows.push({ figure_id: id, ...row });
  }

  return {
    rows,
    coverage: dialogTokens ? round(attributedTokens / dialogTokens, 3) : null,
    dialogTokens,
  };
}

module.exports = { IDIOLECT_MIN_TOKENS, IDIOLECT_TERM_LIMIT, analyzeIdiolect };

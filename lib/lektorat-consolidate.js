'use strict';
// Konsolidierung von Lektorat-Findings über Span-Overlap-Clustering: die Listen
// der Pässe (Objektiv + Stil, bei Prüfung in Stücken je Stück) zu einer
// dublettenfreien Liste verschmelzen — überlappende Funde werden ein Eintrag,
// spezifischster Typ gewinnt. Pure – kein AI/DB.
// Finding-Form: { typ, original, korrektur, erklaerung, ... }.

// Typ-Priorität: spezifisch schlägt generisch. CJS-Spiegel von TYP_PRIORITAET in
// public/js/prompts/lektorat-typen.js, damit die Anti-Doppelungs-Regel im Prompt und
// das Clustering hier dieselbe Rangfolge verwenden. Enthält die Union über alle
// Buchtyp-Profile (die profilfremden Typen tauchen im Input einfach nie auf).
// Drift gegated durch tests/unit/lektorat-typen-drift.test.mjs.
const TYP_PRIORITY = [
  'dialogformat', 'rechtschreibung', 'konjunktiv', 'grammatik',
  'namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede', 'weltfakt',
  'begriffsinkonsistenz', 'autorenform', 'zuschreibung', 'unbelegt', 'wertung',
  'pleonasmus', 'wiederholung', 'perspektivbruch', 'tempuswechsel', 'soziolekt',
  'klischee', 'amtsdeutsch', 'ki_geruch', 'passiv', 'show_vs_tell',
  'hedging', 'filterwort', 'schwaches_verb', 'fuellwort', 'satzbau', 'stil',
];

function _prio(typ) {
  const i = TYP_PRIORITY.indexOf(typ);
  return i < 0 ? TYP_PRIORITY.length : i;
}

function _norm(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Span eines Findings im Text lokalisieren (erstes Vorkommen von `original`).
// → { start, end } oder null, wenn `original` nicht wörtlich im Text steht
// (z.B. weil das Modell normalisiert hat) – solche Funde clustern über
// normalisierte String-Gleichheit statt über Position.
function _locate(finding, text) {
  const orig = finding && finding.original;
  if (!orig || !text) return null;
  const idx = text.indexOf(orig);
  if (idx < 0) return null;
  return { start: idx, end: idx + orig.length };
}

// Lokalisierte Einträge zu Clustern verschmelzen: nach Start sortieren, dann
// überlappende (auch transitiv verkettete) Intervalle zu einer Gruppe. Zwei Spans
// überlappen, wenn a.start < b.end && b.start < a.end.
function _clusterLocated(entries) {
  const sorted = entries.slice().sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const clusters = [];
  let cur = null, curEnd = -1;
  for (const e of sorted) {
    if (cur && e.span.start < curEnd) {
      cur.push(e);
      curEnd = Math.max(curEnd, e.span.end);
    } else {
      cur = [e];
      clusters.push(cur);
      curEnd = e.span.end;
    }
  }
  return clusters;
}

// Nicht-lokalisierte Einträge über normalisierte `original`-Gleichheit gruppieren.
// Leeres original → eigener Singleton (kann nicht matchen).
function _clusterUnlocated(entries) {
  const byKey = new Map();
  const singletons = [];
  for (const e of entries) {
    const k = _norm(e.finding.original);
    if (!k) { singletons.push([e]); continue; }
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  return [...byKey.values(), ...singletons];
}

// Repräsentanten eines Clusters wählen: spezifischster Typ zuerst; bei Gleichstand
// die häufigste (typ|original|korrektur)-Kombination; dann kürzestes `original`
// (präziseste Span). Gibt genau ein Finding zurück (unverändert).
function _pickRepresentative(cluster) {
  const freq = new Map();
  for (const e of cluster) {
    const k = `${e.finding.typ}|${_norm(e.finding.original)}|${_norm(e.finding.korrektur)}`;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  return cluster.slice().sort((a, b) => {
    const pa = _prio(a.finding.typ), pb = _prio(b.finding.typ);
    if (pa !== pb) return pa - pb;
    const ka = `${a.finding.typ}|${_norm(a.finding.original)}|${_norm(a.finding.korrektur)}`;
    const kb = `${b.finding.typ}|${_norm(b.finding.original)}|${_norm(b.finding.korrektur)}`;
    const fa = freq.get(ka), fb = freq.get(kb);
    if (fa !== fb) return fb - fa;
    return (a.finding.original || '').length - (b.finding.original || '').length;
  })[0].finding;
}

// Ein Cluster aus `_clusterLocated` ist eine transitive Kette: A überlappt B, B
// überlappt C, A und C liegen aber auseinander. Eine Kette ist darum nicht ein
// Fund, sondern wird zerlegt: Repräsentant wählen, dessen Gruppe = alle Einträge,
// die SEINEN Span überlappen; der Rest bildet die nächste Runde — das ferne
// Kettenende bleibt ein eigener Fund. Nicht-lokalisierte Cluster (gleiches
// `original`) sind schon eine Gruppe.
// → Repräsentanten
function _splitCluster(cluster) {
  const out = [];
  let rest = cluster;
  while (rest.length) {
    const rep = _pickRepresentative(rest);
    const repEntry = rest.find(e => e.finding === rep);
    const s = repEntry.span;
    const group = s ? rest.filter(e => e.span && e.span.start < s.end && s.start < e.span.end) : rest;
    out.push(rep);
    const used = new Set(group);
    rest = rest.filter(e => !used.has(e));
  }
  return out;
}

// N Fund-Listen (Pässe) zu einer deduplizierten Liste verschmelzen: je Gruppe
// aus `_splitCluster` ein Repräsentant. Ausgabe nach Textposition sortiert
// (nicht-lokalisierte Funde ans Ende, alphabetisch nach original).
function mergePasses(lists, text) {
  const entries = [];
  lists.forEach((list) => {
    (list || []).forEach((finding) => {
      entries.push({ finding, span: _locate(finding, text) });
    });
  });
  const located = entries.filter(e => e.span);
  const unlocated = entries.filter(e => !e.span);
  const clusters = [..._clusterLocated(located), ..._clusterUnlocated(unlocated)];

  const kept = [];
  for (const cluster of clusters) {
    for (const rep of _splitCluster(cluster)) {
      const span = _locate(rep, text);
      kept.push({ finding: rep, sortStart: span ? span.start : Number.MAX_SAFE_INTEGER, orig: rep.original || '' });
    }
  }
  kept.sort((a, b) => a.sortStart - b.sortStart || a.orig.localeCompare(b.orig));
  return kept.map(k => k.finding);
}

module.exports = {
  TYP_PRIORITY,
  mergePasses,
  _prio,
  _norm,
  _locate,
};

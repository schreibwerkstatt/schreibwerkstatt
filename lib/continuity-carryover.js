'use strict';
// Wiedererkennung von Kontinuitäts-Befunden über Prüfläufe hinweg — rein, ohne DB.
//
// Jeder Lauf (Komplettanalyse, Nacht-Cron, „Nur Kontinuität prüfen") legt frische
// Issue-Zeilen an. Ohne Wiedererkennung wäre ein bewusst verworfener Fehlalarm
// („kein Fehler") nach jedem Lauf wieder da. Darum übernimmt das Speichern diesen
// Status eines früheren Befunds, wenn der neue derselbe ist.
//
// Übernommen wird NUR „kein Fehler" (`dismissed`), nie „erledigt" (`resolved`):
// findet ein neuer Lauf den Befund wieder, ist er im Text offenbar nicht behoben.
//
// „Derselbe" kann kein Hash über den Wortlaut sein: das Modell formuliert
// Beschreibung und Zitate in jedem Lauf etwas anders. Gleich sein muss der Typ.
// Betroffene Kapitel und Figuren müssen nur ÜBERLAPPEN (_setsOverlap): das Modell nennt
// mal eine Nebenfigur oder ein drittes Kapitel mehr oder weniger, und an einer exakten
// Mengengleichheit wäre ein abgehakter Fehlalarm genau daran wieder offen. Dazu muss
// der Inhalt der beiden Stellen deutlich überlappen (Wortmengen-Jaccard), damit zwei
// verschiedene Widersprüche desselben Typs im selben Kapitel nicht verwechselt werden.
//
// Massgeblich ist pro wiedererkanntem Befund nur seine JÜNGSTE Zeile: hebt der Autor
// „kein Fehler" an der neuen Kopie auf, darf die ältere, noch verworfene Kopie eines
// früheren Laufs den Status nicht zurückbringen. Ältere Zeilen, die eine Zeile eines
// jüngeren Laufs wiedererkennt, fallen darum als Kandidaten weg.

// Mindest-Überlapp der Stellen-Wortmengen. Startwert, nicht an Echtdaten geeicht:
// dieselbe Stelle neu zitiert teilt Kapitelname und Kernwörter des Zitats, zwei
// verschiedene Widersprüche im selben Kapitel meist nur den Kapitelnamen. Liegt die
// Übernahme daneben, hier nachjustieren (Test: continuity-carryover.test.js).
const STELLEN_OVERLAP_MIN = 0.35;
// Mindest-Jaccard der Kapitel- bzw. Figurenmenge (siehe _setsOverlap).
const SET_OVERLAP_MIN = 0.5;

function _lower(s) { return String(s || '').trim().toLowerCase(); }

function _tokens(...parts) {
  return new Set(parts.join(' ').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 2));
}

function _nameSet(list) {
  return new Set((list || []).map(_lower).filter(Boolean));
}

/** Vergleichsform eines Befunds. Kapitel ausschliesslich als AUFGELÖSTE IDs
 *  (umbenennungsfest): gespeichert werden nur aufgelöste Kapitel-Bridges, ein nicht
 *  auflösbarer Name («Gesamtbuch», Tippfehler) wäre beim nächsten Lauf auf der
 *  alten Seite verschwunden und auf der neuen noch da. Figuren als Namen
 *  (fig_ids wechseln bei Neu-Konsolidierung). */
function issueSignature(issue) {
  const chIds = (issue.chapter_ids || []).filter(id => id != null);
  return {
    typ: _lower(issue.typ),
    kapitel: new Set(chIds.map(Number)),
    figuren: _nameSet(issue.figuren),
    tokens: _tokens(issue.stelle_a, issue.stelle_b),
  };
}

function _jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

/** Kapitel- bzw. Figurenmengen zweier Befunde vereinbar? Gleich, höchstens ein
 *  Element Unterschied (eine Figur mehr/weniger, auch {} ↔ {Marek}), eine nicht-leere
 *  Teilmenge der anderen oder Jaccard ≥ SET_OVERLAP_MIN. Zwei disjunkte nicht-leere
 *  Mengen ({Marek} ↔ {Lena}) sind es nie. */
function _setsOverlap(a, b) {
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  const symDiff = a.size + b.size - 2 * common;
  if (symDiff <= 1) return true;
  if (!common) return false;
  if (common === a.size || common === b.size) return true;
  return common / (a.size + b.size - common) >= SET_OVERLAP_MIN;
}

/** Überlapp-Score, wenn beide derselbe Befund sind, sonst -1. */
function _matchScore(sigA, sigB) {
  if (sigA.typ !== sigB.typ) return -1;
  if (!_setsOverlap(sigA.kapitel, sigB.kapitel) || !_setsOverlap(sigA.figuren, sigB.figuren)) return -1;
  const j = _jaccard(sigA.tokens, sigB.tokens);
  return j >= STELLEN_OVERLAP_MIN ? j : -1;
}

function sameIssue(sigA, sigB) { return _matchScore(sigA, sigB) >= 0; }

/**
 * Übernimmt „kein Fehler" früherer Befunde auf neue.
 * @param {Array} issues  Neue Befunde (Form wie beim Speichern, mit chapter_ids/figuren)
 * @param {Array} prior   Frühere Befunde ALLER Status, NEUESTE ZUERST
 *                        ({ check_id, typ, chapter_ids, figuren, stelle_a, stelle_b,
 *                           dismissed, dismissed_at }). `check_id` gruppiert die Zeilen
 *                        nach Lauf; ohne ihn gilt jede Zeile als eigener Lauf.
 * @returns {Array<{resolved, resolved_at, dismissed, dismissed_at}|null>} je neuem Befund
 *          der übernommene Status oder null. Zuordnung nach bestem Stellen-Überlapp
 *          (bei Gleichstand der jüngere Lauf); jeder frühere Befund vererbt höchstens
 *          einmal. Ist die massgebliche (jüngste) Zeile offen, bleibt der neue offen.
 */
function carryOverStatus(issues, prior) {
  const list = issues || [];
  const out = list.map(() => null);
  const priorArr = prior || [];
  if (!list.length || !priorArr.length) return out;

  // Lauf-Rang: Reihenfolge des ersten Auftretens (neueste zuerst).
  const rankOf = new Map();
  const cands = priorArr.map((p, i) => {
    const g = p.check_id ?? `#${i}`;
    if (!rankOf.has(g)) rankOf.set(g, rankOf.size);
    return { p, rank: rankOf.get(g), sig: issueSignature(p) };
  });

  // Ältere Kopien eines in einem jüngeren Lauf wiedergefundenen Befunds ausblenden.
  // Verglichen wird nur innerhalb desselben Typs (der Rest prüft _matchScore paarweise).
  const byBucket = new Map();
  for (const c of cands) {
    const b = c.sig.typ;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(c);
  }
  const live = [];
  for (const group of byBucket.values()) {
    for (const c of group) {
      const shadowed = group.some(o => o.rank < c.rank && _matchScore(o.sig, c.sig) >= 0);
      if (!shadowed) live.push(c);
    }
  }

  // Alle zulässigen Paare, dann gierig: höchster Überlapp zuerst, bei Gleichstand der
  // jüngere Lauf. Ein Kandidat und ein neuer Befund werden je höchstens einmal vergeben.
  const pairs = [];
  list.forEach((issue, ni) => {
    const sig = issueSignature(issue || {});
    for (let ci = 0; ci < live.length; ci++) {
      const score = _matchScore(sig, live[ci].sig);
      if (score >= 0) pairs.push({ ni, ci, score, rank: live[ci].rank });
    }
  });
  pairs.sort((a, b) => (b.score - a.score) || (a.rank - b.rank) || (a.ci - b.ci) || (a.ni - b.ni));
  const usedNew = new Set();
  const usedCand = new Set();
  for (const { ni, ci } of pairs) {
    if (usedNew.has(ni) || usedCand.has(ci)) continue;
    usedNew.add(ni);
    usedCand.add(ci);
    const { p } = live[ci];
    out[ni] = p.dismissed
      ? { resolved: false, resolved_at: null, dismissed: true, dismissed_at: p.dismissed_at || null }
      : null;
  }
  return out;
}

module.exports = { issueSignature, sameIssue, carryOverStatus, STELLEN_OVERLAP_MIN, SET_OVERLAP_MIN };

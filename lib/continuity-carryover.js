'use strict';
// Wiedererkennung von Kontinuitäts-Befunden über Prüfläufe hinweg — rein, ohne DB.
//
// Jeder Lauf (Komplettanalyse, Nacht-Cron, „Nur Kontinuität prüfen") legt frische
// Issue-Zeilen an. Ohne Wiedererkennung wäre die Triage des Autors — „erledigt",
// „kein Fehler" — nach jedem Lauf weg, und ein bewusst verworfener Fehlalarm käme
// jede Nacht wieder. Darum übernimmt das Speichern den Status eines früheren
// Befunds, wenn der neue derselbe ist.
//
// „Derselbe" kann kein Hash über den Wortlaut sein: das Modell formuliert
// Beschreibung und Zitate in jedem Lauf etwas anders. Stabil sind Typ, betroffene
// Kapitel und Figuren; dazu muss der Inhalt der beiden Stellen deutlich überlappen
// (Wortmengen-Jaccard), damit zwei verschiedene Widersprüche desselben Typs im
// selben Kapitel nicht verwechselt werden.

// Mindest-Überlapp der Stellen-Wortmengen. Startwert, nicht an Echtdaten geeicht:
// dieselbe Stelle neu zitiert teilt Kapitelname und Kernwörter des Zitats, zwei
// verschiedene Widersprüche im selben Kapitel meist nur den Kapitelnamen. Liegt die
// Übernahme daneben, hier nachjustieren (Test: continuity-carryover.test.js).
const STELLEN_OVERLAP_MIN = 0.35;

function _lower(s) { return String(s || '').trim().toLowerCase(); }

function _tokens(...parts) {
  return new Set(parts.join(' ').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 2));
}

function _key(list) {
  return [...new Set((list || []).map(_lower).filter(Boolean))].sort().join('|');
}

/** Vergleichsform eines Befunds. Kapitel bevorzugt als IDs (umbenennungsfest),
 *  sonst Namen; Figuren als Namen (fig_ids wechseln bei Neu-Konsolidierung). */
function issueSignature(issue) {
  const chIds = (issue.chapter_ids || []).filter(id => id != null);
  return {
    typ: _lower(issue.typ),
    kapitel: chIds.length ? 'id:' + [...new Set(chIds.map(Number))].sort((a, b) => a - b).join('|') : 'n:' + _key(issue.kapitel),
    figuren: _key(issue.figuren),
    tokens: _tokens(issue.stelle_a, issue.stelle_b),
  };
}

function _jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}

function sameIssue(sigA, sigB) {
  return sigA.typ === sigB.typ
    && sigA.kapitel === sigB.kapitel
    && sigA.figuren === sigB.figuren
    && _jaccard(sigA.tokens, sigB.tokens) >= STELLEN_OVERLAP_MIN;
}

/**
 * Übernimmt Triage-Status früherer Befunde auf neue.
 * @param {Array} issues  Neue Befunde (Form wie beim Speichern, mit chapter_ids/figuren)
 * @param {Array} prior   Frühere Befunde mit Status, NEUESTE ZUERST
 *                        ({ typ, kapitel, chapter_ids, figuren, stelle_a, stelle_b,
 *                           resolved, resolved_at, dismissed, dismissed_at })
 * @returns {Array<{resolved, resolved_at, dismissed, dismissed_at}|null>} je neuem Befund
 *          der übernommene Status oder null. Jeder frühere Befund wird höchstens einmal
 *          vergeben, der neueste passende gewinnt.
 */
function carryOverStatus(issues, prior) {
  const priorSigs = (prior || []).map(p => ({ p, sig: issueSignature(p) }));
  const used = new Set();
  return (issues || []).map(issue => {
    const sig = issueSignature(issue);
    for (let i = 0; i < priorSigs.length; i++) {
      if (used.has(i)) continue;
      if (!sameIssue(sig, priorSigs[i].sig)) continue;
      used.add(i);
      const { p } = priorSigs[i];
      return {
        resolved: !!p.resolved, resolved_at: p.resolved ? (p.resolved_at || null) : null,
        dismissed: !!p.dismissed, dismissed_at: p.dismissed ? (p.dismissed_at || null) : null,
      };
    }
    return null;
  });
}

module.exports = { issueSignature, sameIssue, carryOverStatus, STELLEN_OVERLAP_MIN };

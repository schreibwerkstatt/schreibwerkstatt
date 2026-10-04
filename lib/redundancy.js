'use strict';
// Redundanz-Radar: pure Vektor-Mathematik für die buchweite Doppelungs-Suche.
// Findet Chunk-Paare unterschiedlicher Entitäten (Seiten), deren Embeddings sich
// bedeutungsmässig stark ähneln — quasi-doppelte Beschreibungen, wiederkehrende
// Bilder, versehentlich zweimal erzählte Szenen. Reiner Ableitungs-Schritt über
// dem bestehenden semantic_chunks-Index (kein Embedding-/KI-Call). Ohne DB-/Netz-
// Abhängigkeit → unit-testbar (tests/unit/redundancy.test.mjs).
//
// Der teure Teil ist O(n²) Cosinus über alle Chunk-Paare. Zwei Massnahmen halten
// das billig: (a) Vektoren werden EINMAL auf Einheitslänge normiert, danach ist
// die Ähnlichkeit ein reines Skalarprodukt (kein Norm pro Paar); (b) der Scan
// läuft blockweise (scanBlock), damit der aufrufende Job zwischen den Blöcken an
// den Event-Loop zurückgeben kann (setImmediate) und den Server nicht einfriert.

const { normName, nameTokens } = require('./name-normalize');

// Sehr kurze Chunks (blosse Überschriften, ein Satz) ranken untereinander
// verrauscht hoch — unter dieser Zeichenzahl gar nicht erst vergleichen.
const MIN_CHARS = 40;

// Figuren-Profile (name+beschreibung) sind kurz und archetyp-lastig, ihre
// Vektor-Nähe ist verrauscht → nur nahezu deckungsgleiche Profile sind ein
// Dubletten-Signal. Fester Floor, unabhängig vom Seiten-Schwellwert der Karte.
const FIGURE_DUPE_THRESHOLD = 0.88;

// Vektor auf Einheitslänge; null bei leerem/Null-Vektor. Danach ist der
// Cosinus ein reines Skalarprodukt.
function unitVector(v) {
  if (!v || !v.length) return null;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  const unit = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) unit[i] = v[i] * inv;
  return unit;
}

// Chunks (jeweils { entity_id, chunk_ix, text, vector }) in parallele, für den
// Scan optimierte Arrays überführen: normierte Vektoren (Einheitslänge) + Meta.
// Chunks unter MIN_CHARS oder mit Nullvektor werden verworfen (fallen aus dem
// Vergleich). Rückgabe: { vecs: Float32Array[], metas: [{entity_id,chunk_ix,text}] }.
function prepare(chunks, { minChars = MIN_CHARS } = {}) {
  const vecs = [];
  const metas = [];
  for (const c of chunks || []) {
    const text = String(c.text == null ? '' : c.text);
    if (text.trim().length < minChars) continue;
    const unit = unitVector(c.vector);
    if (!unit) continue;
    vecs.push(unit);
    metas.push({ entity_id: c.entity_id, chunk_ix: c.chunk_ix, text });
  }
  return { vecs, metas };
}

// Ein Block des oberen Dreiecks-Scans: für i in [iStart, iEnd) alle j > i.
// Vergleicht nur Chunks UNTERSCHIEDLICHER Entitäten (Doppelungen quer durchs
// Buch; chunk-interner Overlap derselben Seite ist trivial ähnlich und kein
// Befund). Hält pro Entitäts-Paar den besten Chunk-Treffer in `best` (Map
// `${a}:${b}` mit a<b → { a_id,a_ix,b_id,b_ix,score,ai,bi }). Mutiert `best` +
// gibt die Zahl der tatsächlich verglichenen Paare zurück (für Reporting).
// skipPair(a, b) (a<b, Entitäts-IDs): optionaler Filter für Paare, die kein
// Befund sein sollen (Nachbarseiten, vom User ignoriert). Läuft erst NACH der
// Schwelle — bei Tausenden Chunks also nur für die wenigen Treffer.
function scanBlock(vecs, metas, iStart, iEnd, threshold, best, { skipPair = null } = {}) {
  let compared = 0;
  const n = vecs.length;
  for (let i = iStart; i < iEnd; i++) {
    const vi = vecs[i];
    const ei = metas[i].entity_id;
    const d = vi.length;
    for (let j = i + 1; j < n; j++) {
      const ej = metas[j].entity_id;
      if (ej === ei) continue; // gleiche Entität → skip
      const vj = vecs[j];
      if (vj.length !== d) continue; // Fremdmodell-Rest → nie Treffer
      compared++;
      let dot = 0;
      for (let k = 0; k < d; k++) dot += vi[k] * vj[k];
      if (dot < threshold) continue;
      // Entitäts-Paar-Key ordnungsunabhängig (a<b), damit beide Richtungen
      // in denselben Bucket fallen und pro Seitenpaar nur der beste Chunk zählt.
      const [a, b, ai, bi] = ei < ej ? [ei, ej, i, j] : [ej, ei, j, i];
      if (skipPair && skipPair(a, b)) continue;
      const key = a + ':' + b;
      const cur = best.get(key);
      if (!cur || dot > cur.score) {
        best.set(key, {
          a_id: a, a_ix: metas[ai].chunk_ix,
          b_id: b, b_ix: metas[bi].chunk_ix,
          score: dot, ai, bi,
        });
      }
    }
  }
  return compared;
}

// Zahl der Paare, die der Dreiecks-Scan bis Zeile `rowEnd` (exklusiv) besucht
// hat: Zeile i vergleicht n-1-i Partner. Frühe Zeilen sind also viel teurer als
// späte — Fortschritt und Blockgrösse rechnen darum in Paaren, nicht in Zeilen.
function pairsBefore(n, rowEnd) {
  const e = Math.max(0, Math.min(rowEnd, n));
  return e * (n - 1) - (e * (e - 1)) / 2;
}

// Ende des nächsten Scan-Blocks ab Zeile `iStart`: so viele Zeilen, bis
// ungefähr `pairBudget` Paare zusammenkommen (mindestens eine Zeile). Hält die
// Event-Loop-Blockade pro Block konstant, statt am Anfang lange und am Ende
// winzige Blöcke zu fahren.
function nextBlockEnd(n, iStart, pairBudget) {
  let end = iStart;
  let pairs = 0;
  while (end < n && (end === iStart || pairs + (n - 1 - end) <= pairBudget)) {
    pairs += n - 1 - end;
    end++;
  }
  return end;
}

// best-Map → sortierte Paar-Liste (höchster Score zuerst), auf topK gekappt.
// Der Passagentext kommt aus metas[ai/bi].text (auf textChars gekürzt) — die
// Karte zeigt ihn eingeklappt an und klappt auf Wunsch die ganze Passage auf.
// truncated = es gab mehr Paare über der Schwelle als topK zeigt.
function finalizePairs(best, metas, { topK = 50, textChars = 1500 } = {}) {
  const all = Array.from(best.values()).sort((x, y) => y.score - x.score);
  const truncated = all.length > topK;
  const pairs = all.slice(0, topK).map(p => ({
    a_id: p.a_id, a_ix: p.a_ix, a_text: metas[p.ai].text.slice(0, textChars),
    b_id: p.b_id, b_ix: p.b_ix, b_text: metas[p.bi].text.slice(0, textChars),
    score: Math.round(p.score * 1000) / 1000,
  }));
  return { pairs, totalFound: all.length, truncated };
}

// Bequemer Voll-Scan in einem Rutsch — für Tests + kleine Bücher. Der Job nutzt
// prepare + scanBlock (blockweise mit Yield) + finalizePairs direkt.
function findRedundantPairs(chunks, { threshold = 0.82, topK = 50, minChars = MIN_CHARS, textChars = 1500, skipPair = null } = {}) {
  const { vecs, metas } = prepare(chunks, { minChars });
  const best = new Map();
  const compared = scanBlock(vecs, metas, 0, vecs.length, threshold, best, { skipPair });
  return { ...finalizePairs(best, metas, { topK, textChars }), comparedPairs: compared, comparedChunks: vecs.length };
}

// ── Figuren-Dubletten-Radar ──────────────────────────────────────────────────
// Anders als die Seiten-Redundanz vergleicht das GANZE Figuren-Profil (EIN
// gemittelter Vektor pro Figur aus name+beschreibung), nicht Chunk-Paare. Figuren-
// Steckbriefe sind kurz und archetyp-lastig → reine Vektor-Nähe ist verrauscht
// (zwei „mürrische Mentoren" ranken hoch, sind aber keine Dublette). Darum zwei
// Gegenmassnahmen: (a) ein hoher Schwellwert (FIGURE_DUPE_THRESHOLD); (b) Fusion
// mit dem lexikalischen Namensabstand (dieselbe SSoT wie die Figuren-Konsolidierung,
// lib/name-normalize.js):
//   - Namen teilen ein bedeutungstragendes Token oder haben denselben
//     normalisierten Namen → `duplicate` (die Namens-Dedup hätte greifen sollen).
//   - Namen lexikalisch verschieden → `alias`: der nicht-triviale Fund — eine
//     mögliche im Text umbenannte/mit Epitheton bezeichnete Figur, die die rein
//     namensbasierte Konsolidierung nie zusammenführt.
// figures: [{ id, fig_id?, name, vector:Float32Array }] (ein Vektor je Figur). Rein
// deterministisch — kein DB-/Netz-/KI-Call. `alias`-Paare zuerst (der wertvolle
// Fund), dann nach Score. N ist die Figurenzahl → O(n²) ist hier trivial klein.
// skipPair(a, b) (a<b, Figuren-IDs): wie bei scanBlock, z.B. vom User ignoriert.
function findFigureDuplicates(figures, { threshold = FIGURE_DUPE_THRESHOLD, topK = 40, skipPair = null } = {}) {
  const items = [];
  for (const f of figures || []) {
    const unit = unitVector(f.vector);
    if (!unit) continue;
    items.push({
      id: f.id, fig_id: f.fig_id ?? null, name: f.name,
      norm: normName(f.name), tokens: new Set(nameTokens(f.name)), vec: unit,
    });
  }
  const all = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.vec.length !== a.vec.length) continue; // Fremdmodell-Rest → nie Treffer
      let dot = 0;
      for (let k = 0; k < a.vec.length; k++) dot += a.vec[k] * b.vec[k];
      if (dot < threshold) continue;
      if (skipPair && skipPair(Math.min(a.id, b.id), Math.max(a.id, b.id))) continue;
      let sharedToken = false;
      for (const t of a.tokens) { if (b.tokens.has(t)) { sharedToken = true; break; } }
      const lexicalOverlap = (!!a.norm && a.norm === b.norm) || sharedToken;
      all.push({
        a_id: a.id, a_fig_id: a.fig_id, a_name: a.name,
        b_id: b.id, b_fig_id: b.fig_id, b_name: b.name,
        score: Math.round(dot * 1000) / 1000,
        lexicalOverlap,
        dupeKind: lexicalOverlap ? 'duplicate' : 'alias',
      });
    }
  }
  // Alias-Paare (namensverschieden = die nicht-triviale Lücke) zuerst, dann Score.
  all.sort((x, y) => (Number(x.lexicalOverlap) - Number(y.lexicalOverlap)) || (y.score - x.score));
  const truncated = all.length > topK;
  return { pairs: all.slice(0, topK), totalFound: all.length, truncated };
}

module.exports = {
  MIN_CHARS, FIGURE_DUPE_THRESHOLD, unitVector, prepare, scanBlock, pairsBefore, nextBlockEnd,
  finalizePairs, findRedundantPairs, findFigureDuplicates,
};

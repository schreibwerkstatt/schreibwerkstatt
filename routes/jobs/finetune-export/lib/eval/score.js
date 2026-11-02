'use strict';

// Regelbewertung einer Eval-Antwort (docs/finetuning.md#5-qualitäts-check) —
// dieselbe Logik wie `docs/unsloth-config/compare_models.py#score_rules`
// (Gleichstand gegated: tests/unit/finetune-eval-score.test.mjs). Sie läuft vor
// dem LLM-Richter (scripts/eval-judge.js) und deckelt dessen Punkte: der Richter
// darf nie höher bewerten, als die Regeln erlauben.
//
// Felder der Eval-Zeile:
//   mustContain      — jeder Begriff (Teilstring, ohne Gross-/Kleinschreibung);
//   mustContainAny   — Synonymgruppen; ohne `minAny` aus JEDER Gruppe einer,
//                      mit `minAny: k` aus mindestens k Gruppen;
//   mustNotContain   — kein Begriff darf vorkommen;
//   Begriffe mit «…» sind Muster mit Lücke («gibt es … nicht»: beide Teile in
//   dieser Reihenfolge, höchstens GAP Zeichen dazwischen);
//   maxOverlapWithProfile — { text, max }: Anteil der 8-Wort-Folgen der
//                      Antwort, die wörtlich im Profil stehen, höchstens `max`;
//   style            — { noEszett, tense: 'past'|'present', noRepeat, noMeta }.
// Ergebnis: { ok, cap, violations } — `cap` 2 (alles erfüllt), 1 (ein Teil
// verletzt) oder 0 (Ausschluss bei einer Ablehnungs-Kategorie, oder nichts
// getroffen).

const GAP = 60;
const REFUSAL_CATEGORIES = new Set(['unknown', 'offTopic', 'mixed', 'meta']);

const low = (s) => String(s || '').toLowerCase();

// Begriff oder Muster mit «…» (Lücke) in `text`?
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function hasTerm(text, term) {
  const parts = low(term).split('…').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 1) return low(text).includes(parts[0]);
  return new RegExp(parts.map(esc).join(`[\\s\\S]{0,${GAP}}?`)).test(low(text));
}

const words = (s) => low(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function shingleOverlap(answer, profile, n = 8) {
  const a = words(answer), p = words(profile);
  if (a.length < n) return 0;
  const set = new Set();
  for (let i = 0; i + n <= p.length; i++) set.add(p.slice(i, i + n).join(' '));
  let hit = 0, total = 0;
  for (let i = 0; i + n <= a.length; i++) { total++; if (set.has(a.slice(i, i + n).join(' '))) hit++; }
  return total ? hit / total : 0;
}

// Ein Teilsatz aus vier Wörtern mindestens dreimal.
function repeats(text) {
  const w = words(text);
  const seen = new Map();
  for (let i = 0; i + 4 <= w.length; i++) {
    const k = w.slice(i, i + 4).join(' ');
    const n = (seen.get(k) || 0) + 1;
    if (n >= 3) return true;
    seen.set(k, n);
  }
  return false;
}

// Metatext statt Prosa: «Kapitel 11», «Das letzte Kapitel endete …», «Teil 2 von 5».
const META_TEXT = /\b(Kapitel|Abschnitt|Chapter|Section)\s+\d+\b|\b(das|im) (letzte|vorige|vorherige)n? Kapitel\b|\bTeil \d+ von \d+\b|\bpart \d+ of \d+\b/i;

const PAST = new Set(['war', 'waren', 'hatte', 'hatten', 'wurde', 'wurden', 'ging', 'sagte', 'kam', 'stand', 'sah', 'wollte', 'konnte', 'musste',
  'was', 'were', 'had', 'did', 'said', 'went', 'came', 'stood', 'saw']);
const PRESENT = new Set(['ist', 'sind', 'hat', 'haben', 'wird', 'werden', 'geht', 'sagt', 'kommt', 'steht', 'sieht', 'will', 'kann', 'muss',
  'is', 'are', 'has', 'have', 'does', 'says', 'goes', 'comes', 'stands', 'sees']);
// Anteil der Präteritum-Formen an allen erkannten finiten Formen; null ohne Treffer.
function pastShare(text) {
  let p = 0, q = 0;
  for (const w of words(text)) { if (PAST.has(w)) p++; else if (PRESENT.has(w)) q++; }
  return p + q ? p / (p + q) : null;
}

function scoreRules(answer, row) {
  const a = String(answer || '');
  const v = [];
  const must = row.mustContain || [];
  const groups = row.mustContainAny || [];
  const banned = row.mustNotContain || [];
  for (const m of must) if (!hasTerm(a, m)) v.push({ rule: 'mustContain', term: m });
  const hitGroups = groups.filter(g => g.some(t => hasTerm(a, t))).length;
  const need = Number.isInteger(row.minAny) ? Math.min(row.minAny, groups.length) : groups.length;
  if (hitGroups < need) v.push({ rule: 'mustContainAny', hit: hitGroups, need });
  const bannedHit = banned.filter(b => hasTerm(a, b));
  if (bannedHit.length) v.push({ rule: 'mustNotContain', terms: bannedHit });
  if (row.maxOverlapWithProfile?.text) {
    const ov = shingleOverlap(a, row.maxOverlapWithProfile.text);
    if (ov > (row.maxOverlapWithProfile.max ?? 0.6)) v.push({ rule: 'maxOverlapWithProfile', overlap: Math.round(ov * 100) / 100 });
  }
  const st = row.style || {};
  if (st.noEszett && /ß/.test(a)) v.push({ rule: 'style.noEszett' });
  if (st.noRepeat && repeats(a)) v.push({ rule: 'style.noRepeat' });
  if (st.noMeta && META_TEXT.test(a)) v.push({ rule: 'style.noMeta' });
  if (st.tense) {
    const share = pastShare(a);
    if (share !== null && (st.tense === 'past' ? share < 0.5 : share > 0.5)) v.push({ rule: 'style.tense', pastShare: Math.round(share * 100) / 100 });
  }
  const hasRules = must.length || groups.length || banned.length || row.maxOverlapWithProfile || Object.keys(st).length;
  if (!hasRules) return { ok: null, cap: 2, violations: [] };
  // Ausschluss bei einer Ablehnung (Porträt eines erfundenen Namens, erledigter
  // Fremdauftrag) oder kein einziges Pflichtkriterium getroffen → 0.
  const refusalBreach = REFUSAL_CATEGORIES.has(row.category) && bannedHit.length;
  const nothing = (must.length || groups.length) && must.every(m => !hasTerm(a, m)) && hitGroups === 0;
  const cap = !v.length ? 2 : refusalBreach || nothing ? 0 : 1;
  return { ok: !v.length, cap, violations: v };
}

module.exports = { scoreRules, hasTerm, shingleOverlap, pastShare, repeats, META_TEXT, GAP };

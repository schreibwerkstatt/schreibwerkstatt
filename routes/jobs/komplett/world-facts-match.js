'use strict';
// Welt-Fakten einer neuen Analyse gegen die Entscheide des Autors abgleichen — VOR dem
// synchronen Full-Replace (db/world-facts.js#saveFaktenToDb), weil Embeddings async sind.
//
// Die Extraktion formuliert dieselbe Aussage bei jedem Lauf etwas anders; der exakte
// Aussage-Schlüssel (lib/world-fact-key.js) erkennt das nicht. Ohne diesen Abgleich käme
// ein gelöschter Analyse-Fakt beim nächsten Lauf zurück, und ein korrigierter stünde
// danach doppelt da (Autor-Fassung + neue Umformulierung des Originals).
//
// Anker (listFactAnchors): verworfene Aussagen (world_fact_suppressions, Ziel = gepflegter
// Ersatz oder null) und gepflegte Fakten (Ziel = sie selbst). Verglichen wird nur unter
// GLEICHEM Subjekt (normalisiert) — das hält die Zahl der Embeddings klein (Prod-Backend
// ~1,4 Texte/s) und schliesst Treffer über verschiedene Gegenstände aus. Schwelle
// `weltfakten.match_min_score` (kalibriert, siehe Registry-Kommentar).
//
// Best-effort: ohne Embedding-Backend, bei einem Backend-Fehler oder über dem Deckel
// bleibt es beim exakten Schlüssel — der Lauf scheitert daran nie.

const embed = require('../../../lib/embed');
const appSettings = require('../../../lib/app-settings');
const { listFactAnchors } = require('../../../db/schema');
const { factKey } = require('../../../lib/world-fact-key');

// Höchstzahl Texte (Anker + Kandidaten) je Lauf. Bei ~1,4 Texten/s auf Prod ≈ 2–3 Minuten.
const MAX_EMBED_TEXTS = 200;

function _subj(s) {
  return String(s || '').normalize('NFC').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim();
}

function _text(subjekt, fakt) {
  const s = String(subjekt || '').trim();
  return s ? `${s}: ${fakt || ''}` : String(fakt || '');
}

function _cos(a, b) {
  let d = 0; let x = 0; let y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

function _minScore() {
  const v = Number(appSettings.get('weltfakten.match_min_score'));
  return Number.isFinite(v) && v > 0 ? v : 0.82;
}

/** Kandidaten-Paare bauen (rein, ohne Netz): Analyse-Aussagen ohne exakten Treffer, deren
 *  Subjekt auch ein Anker trägt. @returns {{ anchors, cands }} je mit `subj`, `text`. */
function _pairs(anchors, chapterFakten) {
  const anchorKeys = new Set(anchors.map(a => a.key));
  const bySubj = new Map();
  for (const a of anchors) {
    const s = _subj(a.subjekt);
    if (!bySubj.has(s)) bySubj.set(s, []);
    bySubj.get(s).push({ ...a, subj: s, text: _text(a.subjekt, a.fakt) });
  }
  const seen = new Set();
  const cands = [];
  for (const cf of chapterFakten || []) {
    for (const f of cf?.fakten || []) {
      const fakt = String(f?.fakt || '').trim();
      if (!fakt) continue;
      const subjekt = String(f?.subjekt || '').trim() || null;
      const key = factKey(subjekt, fakt);
      if (seen.has(key) || anchorKeys.has(key)) continue;
      seen.add(key);
      const s = _subj(subjekt);
      if (!bySubj.has(s)) continue;
      cands.push({ key, subj: s, text: _text(subjekt, fakt) });
    }
  }
  return { bySubj, cands };
}

/**
 * @returns {Promise<Map<string, {target: number|null, score: number}>>} factKey der
 *   Analyse-Aussage → Ziel (gepflegter Fakt) bzw. null (verwerfen).
 */
async function matchFactAnchors(bookId, userEmail, chapterFakten, { signal, log } = {}) {
  const out = new Map();
  const anchors = listFactAnchors(bookId, userEmail);
  if (!anchors.length || !embed.isEnabled()) return out;
  const { bySubj, cands } = _pairs(anchors, chapterFakten);
  if (!cands.length) return out;

  const usedSubj = new Set(cands.map(c => c.subj));
  const anchorList = [...bySubj.entries()].filter(([s]) => usedSubj.has(s)).flatMap(([, a]) => a);
  let candList = cands;
  if (anchorList.length + candList.length > MAX_EMBED_TEXTS) {
    candList = cands.slice(0, Math.max(0, MAX_EMBED_TEXTS - anchorList.length));
    log?.warn?.(`Welt-Fakten-Abgleich: ${cands.length - candList.length} von ${cands.length} Aussagen nur über den exakten Schlüssel geprüft (Deckel ${MAX_EMBED_TEXTS}).`);
  }
  if (!candList.length) return out;

  let vecs;
  try {
    vecs = await embed.embedBatch([...anchorList.map(a => a.text), ...candList.map(c => c.text)], { signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    log?.warn?.(`Welt-Fakten-Abgleich übersprungen (Embedding-Fehler): ${e.message}`);
    return out;
  }
  const aVec = new Map(anchorList.map((a, i) => [a, vecs[i]]));
  const min = _minScore();
  candList.forEach((c, i) => {
    const v = vecs[anchorList.length + i];
    let best = null;
    for (const a of bySubj.get(c.subj) || []) {
      const av = aVec.get(a);
      if (!av || !v) continue;
      const score = _cos(av, v);
      if (score >= min && (!best || score > best.score)) best = { target: a.target, score };
    }
    if (best) out.set(c.key, best);
  });
  if (out.size) log?.info?.(`Welt-Fakten-Abgleich: ${out.size} Umformulierung(en) verworfener oder gepflegter Fakten erkannt.`);
  return out;
}

module.exports = { matchFactAnchors, _pairs, MAX_EMBED_TEXTS };

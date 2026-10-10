'use strict';
// Belegstellen der Kontinuitätsprüfung im Buchtext verorten — rein, ohne DB.
//
// Ein Befund nennt zwei Stellen («Kapitel 3: «Zitat»»). Drei Konsumenten brauchen
// dieselbe Frage „wo steht das?":
//   - die Beleg-Prüfung beim Speichern (Single-Pass): ein Zitat, das im Buch nicht
//     vorkommt, ist erfunden → Befund verwerfen;
//   - die Seiten-Zuordnung beim Speichern: die Karte springt auf die Seite, auf der
//     die Stelle steht, statt auf die erste Kapitelseite;
//   - die Verify-Stufe (Multi-Pass): sie braucht den Originaltext rund um die Stelle.
//
// Im Multi-Pass zitiert das Modell keine Buchsätze, sondern die extrahierten Fakten
// («Marek: liegt tot unter den Trümmern»). Diese Fakten tragen den Seitennamen, auf
// dem sie stehen (`seite`) — darüber findet sich die Seite auch ohne wörtliches Zitat.
//
// Der Zitat-Abgleich ist der von lib/quote-verify.js (tolerant gegen Anführungs-/
// Strich-/Whitespace-Varianten und Auslassungen), keine zweite Normalisierung. Die
// Kontinuität nutzt dort zusätzlich die Option `ignorePunctuation`: ein Zitat, das sich
// nur in Satzzeichen vom Text unterscheidet (Komma weggelassen, Gedankenstrich statt
// Komma), ist nicht erfunden und soll seine Seite finden.

const { normalizeForQuoteMatch, quoteFoundIn, quoteParts } = require('./quote-verify');

const LOOSE = { ignorePunctuation: true };

// Kürzere Zitate/Fakten sind zu unspezifisch, um eine Seite zu identifizieren.
const MIN_MATCH_CHARS = 12;
// Ab diesem Wortüberlapp gilt ein Stellen-Text als Paraphrase eines Fakts.
const FACT_OVERLAP_MIN = 0.6;
// Untergrenze des Nenners im Überlapp-Score: ohne sie gewänne ein Fakt mit zwei
// Inhaltswörtern («Marek: tot») gegen jedes Zitat, das diese zwei Wörter enthält (2/2).
// So braucht ein Paraphrase-Treffer mindestens drei gemeinsame Wörter.
const FACT_MIN_TOKENS = 4;

const _norm = normalizeForQuoteMatch;

function _tokens(s) {
  return new Set(_norm(s).split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2));
}

/** Seiten in Suchform: [{ id, title, chapter, chapter_id, text, norm }]. Reihenfolge
 *  = Buchreihenfolge (wie pageContents). */
function buildPageIndex(pageContents) {
  return (pageContents || [])
    .filter(p => p && p.id != null && p.text)
    .map(p => ({
      id: Number(p.id), title: p.title || '', chapter: p.chapter || null,
      chapter_id: p.chapter_id ?? null, text: p.text, norm: _norm(p.text),
      loose: normalizeForQuoteMatch(p.text, LOOSE),
    }));
}

/** Fakten in Suchform. `chapterFacts` = [{ kapitel, fakten:[{ subjekt, fakt, seite }] }]. */
function buildFactIndex(chapterFacts) {
  const out = [];
  for (const cf of (chapterFacts || [])) {
    for (const f of (cf?.fakten || [])) {
      if (!f?.fakt) continue;
      const line = `${f.subjekt ? f.subjekt + ': ' : ''}${f.fakt}`;
      out.push({ kapitel: cf.kapitel || '', seite: f.seite || '', norm: _norm(line), factNorm: _norm(f.fakt), tokens: _tokens(line) });
    }
  }
  return out;
}

// Seiten der genannten Kapitel zuerst, dann der Rest — ein Zitat steht fast immer
// im Kapitel, das der Befund nennt, aber das Modell vertauscht Kapitel gelegentlich.
// Kapitelnamen kommen roh aus der Modell-Antwort — gelegentlich als Objekt
// ({ name: … }) statt String; ein String(obj) wäre «[object Object]».
function _kapName(k) {
  if (k == null) return '';
  if (typeof k === 'object') return String(k.name || k.titel || k.label || '').trim();
  return String(k).trim();
}

function _ordered(pages, kapitel) {
  const names = new Set((kapitel || []).map(_kapName).filter(Boolean));
  if (!names.size) return pages;
  const first = [], rest = [];
  for (const p of pages) (names.has(p.chapter) ? first : rest).push(p);
  return first.concat(rest);
}

/** Seite, auf der das wörtliche Zitat steht, oder null. Erst streng, dann
 *  satzzeichen-tolerant — beides in Kapitel-Reihenfolge. */
function locateQuote(quote, pages, kapitel) {
  if (_norm(quote).length < MIN_MATCH_CHARS) return null;
  const ordered = _ordered(pages, kapitel);
  for (const p of ordered) if (quoteFoundIn(quote, p.norm)) return p;
  for (const p of ordered) if (quoteFoundIn(quote, p.loose ?? normalizeForQuoteMatch(p.text, LOOSE), LOOSE)) return p;
  return null;
}

// Fakten der genannten Kapitel und der Rest, getrennt — wie _ordered für Seiten.
function _factGroups(facts, kapitel) {
  const names = new Set((kapitel || []).map(_kapName).filter(Boolean));
  if (!names.size) return [facts];
  const first = [], rest = [];
  for (const f of facts) (names.has(f.kapitel) ? first : rest).push(f);
  return first.length ? [first, rest] : [rest];
}

function _bestFact(n, tq, group) {
  for (const f of group) {
    if (f.factNorm.length >= MIN_MATCH_CHARS && (n.includes(f.factNorm) || f.norm.includes(n))) return f;
  }
  if (!tq.size) return null;
  let best = null, bestScore = 0, bestCommon = 0;
  for (const f of group) {
    let common = 0;
    for (const t of tq) if (f.tokens.has(t)) common++;
    if (!common) continue;
    const score = common / Math.max(Math.min(tq.size, f.tokens.size), FACT_MIN_TOKENS);
    if (score > bestScore || (score === bestScore && common > bestCommon)) {
      best = f; bestScore = score; bestCommon = common;
    }
  }
  return bestScore >= FACT_OVERLAP_MIN ? best : null;
}

/** Fakt, den ein Stellen-Text zitiert (wörtlich enthalten oder klare Paraphrase), oder null.
 *  Fakten der im Befund genannten Kapitel (`kapitel`) gehen vor: erst wenn dort keiner
 *  trifft, wird im übrigen Buch gesucht. */
function locateFact(text, facts, { kapitel = [] } = {}) {
  const n = _norm(text);
  if (n.length < MIN_MATCH_CHARS || !facts?.length) return null;
  const tq = _tokens(text);
  for (const group of _factGroups(facts, kapitel)) {
    const hit = _bestFact(n, tq, group);
    if (hit) return hit;
  }
  return null;
}

/** Seite, auf der ein Fakt steht (Seitenname, bevorzugt im Fakt-Kapitel), oder null. */
function pageForFact(fact, pages) {
  const seite = _norm(fact?.seite).replace(/^#+\s*/, '');
  if (!seite) return null;
  const hits = pages.filter(p => _norm(p.title) === seite);
  if (!hits.length) return null;
  return hits.find(p => p.chapter === fact.kapitel) || hits[0];
}

/**
 * Seite einer Befund-Stelle: erst das wörtliche Zitat im Buchtext, dann (Multi-Pass)
 * der zitierte Fakt und dessen Seitenname. null, wenn beides nichts findet.
 * @param {string} stelle  Roher Stellen-Text («Kapitel 3: «…»»)
 * @param {string} quote   Daraus extrahiertes Zitat (utils#_stelleQuote), ggf. ''
 */
function locateStelle(stelle, quote, pages, { kapitel = [], facts = null } = {}) {
  if (!pages?.length) return null;
  if (quote) {
    const p = locateQuote(quote, pages, kapitel);
    if (p) return p;
  }
  if (facts?.length) {
    const f = locateFact(quote || stelle, facts, { kapitel });
    if (f) return pageForFact(f, pages);
  }
  return null;
}

// Vergleichsform mit Rückverweis: norm[i] stammt aus raw[map[i]]. Dieselben
// Vereinheitlichungen wie normalizeForQuoteMatch (unsichtbare Zeichen weg, Anführungs-/
// Strich-/Leerraum-Varianten gleich, Strich ohne Leerraum, Kleinschreibung) — ohne die
// Klammer-Auslassung, die ein Zitat-Fragment nach splitEllipsis nicht mehr trägt.
const _INVISIBLE = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/;
const _QUOTE = /[«»„“”‟"‹›‚‘’'‛ʼ´`′″]/;
const _DASH = /[‐-―−⸺⸻﹘﹣－-]/;
// `loose`: Satzzeichen (inkl. aller Anführungs-/Strich-Varianten, die die strenge Form
// auf " bzw. - abbildet) zählen als Leerraum — Spiegel von quote-verify#ignorePunctuation.
const _PUNCT = /\p{P}/u;
function _normWithMap(raw, { loose = false } = {}) {
  const out = [];
  const map = [];
  const push = (ch, i) => { for (const c of ch.toLowerCase()) { out.push(c); map.push(i); } };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (_INVISIBLE.test(ch)) continue;
    if (/\s/.test(ch) || (loose && (_PUNCT.test(ch) || _QUOTE.test(ch) || _DASH.test(ch)))) {
      const prev = out[out.length - 1];
      if (out.length && prev !== ' ' && (loose || prev !== '-')) push(' ', i);
      continue;
    }
    if (_DASH.test(ch)) {
      if (out[out.length - 1] === '-') continue;
      if (out[out.length - 1] === ' ') { out.pop(); map.pop(); }
      push('-', i);
      continue;
    }
    push(_QUOTE.test(ch) ? '"' : ch, i);
  }
  return { norm: out.join(''), map };
}

/** Rohe Fundstelle eines Zitats in einem Text ({ start, end } in Zeichen von `text`)
 *  oder null — tolerant wie quoteFoundIn: Anführungs-/Strich-/Leerraum-Varianten,
 *  unsichtbare Zeichen, Auslassungen («…», «[…]») trennen Fragmente, die einzeln und
 *  in Reihenfolge vorkommen müssen. Zu kurze Zitate (< MIN_MATCH_CHARS) gelten als
 *  nicht auffindbar. */
function locateInText(text, quote) {
  const raw = String(text || '');
  const qn = normalizeForQuoteMatch(quote);
  if (!raw || qn.length < MIN_MATCH_CHARS) return null;
  // Erst streng, dann satzzeichen-tolerant (Komma/Strich/Auslassung variiert).
  return _locateParts(raw, quoteParts(quote), false) || _locateParts(raw, quoteParts(quote, LOOSE), true);
}

function _locateParts(raw, parts, loose) {
  if (!parts.length) return null;
  const { norm, map } = _normWithMap(raw, { loose });
  let from = 0, first = -1, last = -1;
  for (const part of parts) {
    const at = norm.indexOf(part, from);
    if (at < 0) return null;
    if (first < 0) first = at;
    last = at + part.length - 1;
    from = at + part.length;
  }
  return { start: map[first], end: map[last] + 1 };
}

/** Textfenster (±radius) rund ums Zitat in einem Text, whitespace-geglättet.
 *  `{ text, located }`: located=true nur bei Zitat-Treffer; ohne Treffer leerer Text —
 *  die Wahl eines Ersatz-Ausschnitts (Seiten-/Kapitel-Anfang, semantische Passage)
 *  trifft der Aufrufer. */
function excerptAround(text, quote, radius) {
  const raw = String(text || '');
  const hit = locateInText(raw, quote);
  if (!hit) return { text: '', located: false };
  const slice = raw.slice(Math.max(0, hit.start - radius), Math.min(raw.length, hit.end + radius));
  return { text: slice.replace(/\s+/g, ' ').trim(), located: true };
}

/** Textfenster (±radius) rund ums Zitat auf einer Seite — `{ text, located }` wie
 *  excerptAround; ohne Treffer `{ text: '', located: false }`. */
function excerptOnPage(page, quote, radius) {
  return excerptAround(page?.text, quote, radius);
}

/**
 * Beleg-Prüfung für Befunde, deren Zitate wörtlich aus dem Buchtext stammen sollen.
 * Erfunden ist ein Befund, sobald EIN geliefertes Zitat im Text fehlt — eine echte
 * und eine erfundene Stelle ergeben keinen belegten Widerspruch. Stellen ohne
 * Anführungszeichen (Anachronismus-Jahresangabe, Attribut-Detektor) prüft das nicht.
 * @param {string[]} quotes  Extrahierte Zitate der Stellen (leere werden ignoriert)
 * @param {string} hayNorm   normalizeForQuoteMatch(Buchtext)
 * @param {{hayLoose?: string}} [opts]  normalizeForQuoteMatch(Buchtext, { ignorePunctuation:
 *   true }) — mit ihr gilt ein Zitat, das nur in Satzzeichen abweicht, als belegt.
 */
function quotesFabricated(quotes, hayNorm, { hayLoose = null } = {}) {
  const list = (quotes || []).filter(Boolean);
  const found = (q) => quoteFoundIn(q, hayNorm) || (hayLoose != null && quoteFoundIn(q, hayLoose, LOOSE));
  return list.length > 0 && !list.every(found);
}

module.exports = {
  buildPageIndex, buildFactIndex,
  locateQuote, locateFact, pageForFact, locateStelle,
  excerptOnPage, excerptAround, locateInText, quotesFabricated,
  normalizeForQuoteMatch, MIN_MATCH_CHARS,
};

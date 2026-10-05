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
// Strich-/Whitespace-Varianten und Auslassungen), keine zweite Normalisierung.

const { normalizeForQuoteMatch, quoteFoundIn, splitEllipsis } = require('./quote-verify');

// Kürzere Zitate/Fakten sind zu unspezifisch, um eine Seite zu identifizieren.
const MIN_MATCH_CHARS = 12;
// Ab diesem Wortüberlapp gilt ein Stellen-Text als Paraphrase eines Fakts.
const FACT_OVERLAP_MIN = 0.6;

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

/** Seite, auf der das wörtliche Zitat steht, oder null. */
function locateQuote(quote, pages, kapitel) {
  if (_norm(quote).length < MIN_MATCH_CHARS) return null;
  for (const p of _ordered(pages, kapitel)) if (quoteFoundIn(quote, p.norm)) return p;
  return null;
}

/** Fakt, den ein Stellen-Text zitiert (wörtlich enthalten oder klare Paraphrase), oder null. */
function locateFact(text, facts) {
  const n = _norm(text);
  if (n.length < MIN_MATCH_CHARS || !facts?.length) return null;
  for (const f of facts) {
    if (f.factNorm.length >= MIN_MATCH_CHARS && (n.includes(f.factNorm) || f.norm.includes(n))) return f;
  }
  const tq = _tokens(text);
  if (!tq.size) return null;
  let best = null, bestScore = 0;
  for (const f of facts) {
    let common = 0;
    for (const t of tq) if (f.tokens.has(t)) common++;
    const score = common / Math.min(tq.size, f.tokens.size || 1);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return bestScore >= FACT_OVERLAP_MIN ? best : null;
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
    const f = locateFact(quote || stelle, facts);
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
function _normWithMap(raw) {
  const out = [];
  const map = [];
  const push = (ch, i) => { for (const c of ch.toLowerCase()) { out.push(c); map.push(i); } };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (_INVISIBLE.test(ch)) continue;
    if (/\s/.test(ch)) {
      const prev = out[out.length - 1];
      if (out.length && prev !== ' ' && prev !== '-') push(' ', i);
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
  const parts = splitEllipsis(qn);
  if (!parts.length) return null;
  const { norm, map } = _normWithMap(raw);
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
 */
function quotesFabricated(quotes, hayNorm) {
  const list = (quotes || []).filter(Boolean);
  return list.length > 0 && !list.every(q => quoteFoundIn(q, hayNorm));
}

module.exports = {
  buildPageIndex, buildFactIndex,
  locateQuote, locateFact, pageForFact, locateStelle,
  excerptOnPage, excerptAround, locateInText, quotesFabricated,
  normalizeForQuoteMatch, MIN_MATCH_CHARS,
};

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

const { normalizeForQuoteMatch, quoteFoundIn } = require('./quote-verify');

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
function _ordered(pages, kapitel) {
  const names = new Set((kapitel || []).map(k => String(k || '').trim()).filter(Boolean));
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

/** Textfenster (±radius) rund ums Zitat auf einer Seite; ohne Treffer der Seitenanfang. */
function excerptOnPage(page, quote, radius) {
  const full = String(page?.text || '').replace(/\s+/g, ' ');
  if (!full) return '';
  const needle = String(quote || '').replace(/\s+/g, ' ').slice(0, 40);
  const idx = needle.length >= MIN_MATCH_CHARS ? full.indexOf(needle) : -1;
  if (idx < 0) return full.slice(0, radius * 2);
  return full.slice(Math.max(0, idx - radius), Math.min(full.length, idx + needle.length + radius));
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
  excerptOnPage, quotesFabricated,
  normalizeForQuoteMatch,
};

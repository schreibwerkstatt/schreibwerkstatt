'use strict';
// Validiert die `zitate`-Liste eines final_answer-Calls gegen den aktuellen
// Seitentext. Wird vom Loop in chat.js aufgerufen, NICHT als Tool registriert.

const { resolvePageBookId } = require('../../../lib/content-ownership');
const contentStore = require('../../../lib/content-store');
const { htmlToPlainText } = require('../../../lib/html-text');
const { normalizeForQuoteMatch, quoteFoundIn, quoteParts } = require('../../../lib/quote-verify');

// Stimmt das Zitat, aber nicht die Position (Modell hat offset/length verzählt — der
// häufigste Grund für quote_mismatch), wird es im Seitentext NEU VERANKERT statt als
// ungültig markiert: exakt (nächste Fundstelle zum genannten offset), sonst tolerant
// gegenüber Anführungs-/Strich-/Whitespace-Varianten (lib/quote-verify.js). Kostet
// keinen KI-Call und zeigt weiter das Zitat, das das Modell gemeint hat — anders als
// `actual` (Text an der falschen Position) oder ein zweiter Synthese-Turn.
// Auch der tolerante Treffer liefert echte Offsets im Seitentext: die Hervorhebung
// zeigt sonst auf die verzählte Stelle. Lässt sich die Fundstelle nicht sicher
// zurückrechnen, gibt es keine Neu-Verankerung (das Zitat bleibt ungültig).
const RELOCATE_MIN_CHARS = 12;
// Höchstens so viele tolerante Fundstellen prüfen (Zitat kommt mehrfach vor).
const RELOCATE_MAX_CANDIDATES = 20;

// Länge der Vergleichsform des Präfixes text[0, k).
function _normLen(text, k) {
  return normalizeForQuoteMatch(text.slice(0, k)).length;
}
// Kleinstes k mit _normLen(text, k) > n — also das Original-Zeichen, das an Position
// n der Vergleichsform steht (+1). Binärsuche: die Präfix-Länge wächst praktisch
// monoton; ein Ausreisser (eingeklammerte Auslassung) fängt die Prüfung danach ab.
function _origIndexAfter(text, n) {
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_normLen(text, mid + 1) > n) hi = mid; else lo = mid + 1;
  }
  return lo + 1;
}

// Tolerante Fundstellen (Vergleichsform) eines Zitats: [start, end) der ganzen Kette
// seiner Fragmente (Auslassungen dazwischen).
function _tolerantSpans(hayNorm, parts) {
  const spans = [];
  for (let at = hayNorm.indexOf(parts[0]); at >= 0 && spans.length < RELOCATE_MAX_CANDIDATES; at = hayNorm.indexOf(parts[0], at + 1)) {
    let from = at + parts[0].length;
    let ok = true;
    for (const part of parts.slice(1)) {
      const p = hayNorm.indexOf(part, from);
      if (p < 0) { ok = false; break; }
      from = p + part.length;
    }
    if (ok) spans.push([at, from]);
  }
  return spans;
}

function _relocate(text, quote, offset) {
  if (typeof quote !== 'string' || quote.trim().length < RELOCATE_MIN_CHARS) return null;
  let best = -1;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    if (best < 0 || Math.abs(at - offset) < Math.abs(best - offset)) best = at;
  }
  if (best >= 0) return { offset: best, length: quote.length, match: 'exact' };
  const hayNorm = normalizeForQuoteMatch(text);
  const parts = quoteParts(quote);
  if (!parts.length || !quoteFoundIn(quote, hayNorm)) return null;
  const target = Number.isInteger(offset) && offset > 0 ? _normLen(text, Math.min(offset, text.length)) : 0;
  const spans = _tolerantSpans(hayNorm, parts)
    .sort((a, b) => Math.abs(a[0] - target) - Math.abs(b[0] - target));
  for (const [ns, ne] of spans) {
    const start = _origIndexAfter(text, ns) - 1;
    const end = _origIndexAfter(text, ne - 1);
    if (start < 0 || end <= start || end > text.length) continue;
    // Gegenprobe am Original: der Ausschnitt muss das Zitat selbst tragen.
    if (!quoteFoundIn(quote, normalizeForQuoteMatch(text.slice(start, end)))) continue;
    return { offset: start, length: end - start, match: 'tolerant' };
  }
  return null;
}

// Zitate pro Antwort: mehr zeigt die Fussnoten-Liste nicht an (book-chat-agent.js
// #_buildCitations), und jedes weitere kostet einen Seiten-Load.
const MAX_FINAL_CITATIONS = 30;

async function validateFinalAnswerCitations(zitate, ctx) {
  if (!Array.isArray(zitate) || !zitate.length) return [];
  const cache = new Map(); // page_id → plain text
  const out = [];
  for (const z of zitate.slice(0, MAX_FINAL_CITATIONS)) {
    const pageId = z?.page_id;
    const offset = z?.offset;
    const length = z?.length;
    const quote  = typeof z?.quote === 'string' ? z.quote : null;
    if (!Number.isInteger(pageId) || !Number.isInteger(offset) || !Number.isInteger(length)) {
      out.push({ page_id: pageId ?? null, valid: false, reason: 'bad_shape' });
      continue;
    }
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (resolvePageBookId(pageId) !== ctx.bookId) {
      out.push({ page_id: pageId, valid: false, reason: 'page_not_in_book' });
      continue;
    }
    let text = cache.get(pageId);
    if (text == null) {
      try {
        const pd = await contentStore.loadPage(pageId);
        text = htmlToPlainText(pd.html || '');
        cache.set(pageId, text);
      } catch (e) {
        out.push({ page_id: pageId, valid: false, reason: `load_failed: ${e.message}` });
        continue;
      }
    }
    const inRange = offset >= 0 && offset + length <= text.length;
    const actual = inRange ? text.slice(offset, offset + length) : null;
    if (quote != null && actual !== quote) {
      const moved = _relocate(text, quote, offset);
      if (moved) {
        out.push({ page_id: pageId, offset: moved.offset, length: moved.length, valid: true, relocated: moved.match });
        continue;
      }
    }
    if (!inRange) {
      out.push({ page_id: pageId, offset, length, valid: false, reason: 'out_of_range', page_chars: text.length });
      continue;
    }
    const valid  = quote == null ? true : actual === quote;
    out.push({
      page_id: pageId,
      offset,
      length,
      valid,
      ...(valid ? {} : { reason: 'quote_mismatch', expected: quote, actual }),
    });
  }
  return out;
}

module.exports = { validateFinalAnswerCitations, _relocate, MAX_FINAL_CITATIONS };

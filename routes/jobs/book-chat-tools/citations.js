'use strict';
// Validiert die `zitate`-Liste eines final_answer-Calls gegen den aktuellen
// Seitentext. Wird vom Loop in chat.js aufgerufen, NICHT als Tool registriert.

const { resolvePageBookId } = require('../../../lib/content-ownership');
const contentStore = require('../../../lib/content-store');
const { htmlToPlainText } = require('../../../lib/html-text');
const { normalizeForQuoteMatch, quoteFoundIn } = require('../../../lib/quote-verify');

// Stimmt das Zitat, aber nicht die Position (Modell hat offset/length verzählt — der
// häufigste Grund für quote_mismatch), wird es im Seitentext NEU VERANKERT statt als
// ungültig markiert: exakt (nächste Fundstelle zum genannten offset), sonst tolerant
// gegenüber Anführungs-/Strich-/Whitespace-Varianten (lib/quote-verify.js). Kostet
// keinen KI-Call und zeigt weiter das Zitat, das das Modell gemeint hat — anders als
// `actual` (Text an der falschen Position) oder ein zweiter Synthese-Turn.
const RELOCATE_MIN_CHARS = 12;
function _relocate(text, quote, offset) {
  if (typeof quote !== 'string' || quote.trim().length < RELOCATE_MIN_CHARS) return null;
  let best = -1;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    if (best < 0 || Math.abs(at - offset) < Math.abs(best - offset)) best = at;
  }
  if (best >= 0) return { offset: best, length: quote.length, match: 'exact' };
  return quoteFoundIn(quote, normalizeForQuoteMatch(text)) ? { match: 'tolerant' } : null;
}

async function validateFinalAnswerCitations(zitate, ctx) {
  if (!Array.isArray(zitate) || !zitate.length) return [];
  const cache = new Map(); // page_id → plain text
  const out = [];
  for (const z of zitate) {
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
        out.push({ page_id: pageId, offset: moved.offset ?? offset, length: moved.length ?? length, valid: true, relocated: moved.match });
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

module.exports = { validateFinalAnswerCitations, _relocate };

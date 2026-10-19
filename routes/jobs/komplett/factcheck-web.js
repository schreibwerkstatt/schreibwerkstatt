'use strict';
// Weltfakten-Faktencheck auf dem Suchweg SearXNG (lib/websearch#webSearchMode):
// ein Judge-Call je Fakt mit zwei Function-Tools statt Anthropics Server-Tool.
//
//   web_search    { query } → SearXNG-Treffer (Titel, URL, Snippet), höchstens
//                             MAX_SEARCHES je Fakt.
//   read_web_page { url }   → Seiten- oder PDF-Text über lib/url-scrape (safeFetch, SSRF-Guard —
//                             die URL kommt vom Modell), höchstens MAX_PAGE_READS je Fakt,
//                             nur URLs aus den Treffern dieses Fakts.
//
// Die Schleife führt die tool_use-Runden selbst aus (es gibt keinen agentischen Loop
// für den Faktencheck) und endet, sobald das Modell ohne Werkzeug antwortet — mit
// dem JSON-Urteil als Text, wie auf dem Anthropic-Weg.
//
// Beleg-Härtung: alle URLs, die das Modell gesehen hat, sammelt `evidence`. Ein
// «falsch» zählt nur mit einer `quelle` daraus (oder aus der Recherche des Autors);
// sonst macht der Job daraus «unklar». Der Anthropic-Weg kennt diese Liste nicht.

const searxng = require('../../../lib/websearch/searxng');
const urlScrape = require('../../../lib/url-scrape');
const { normalizeUrl } = require('../../../lib/url-normalize');
const { i18nError } = require('../shared');

const MAX_SEARCHES = 3;
const MAX_PAGE_READS = 1;
const MAX_TURNS = 6;
const PAGE_TEXT_MAX = 6000;

/** Ein Beleg-Speicher je Fakt: normalisierte URLs, die das Modell gesehen hat. */
function makeEvidence() {
  const urls = new Set();
  return {
    add(url) { const n = normalizeUrl(url); if (n) urls.add(n); },
    has(url) { const n = normalizeUrl(url); return !!n && urls.has(n); },
    get size() { return urls.size; },
  };
}

async function _webSearch(input, st, opts) {
  const query = String(input?.query || '').trim();
  if (!query) return { error: 'query fehlt.' };
  if (st.searches >= MAX_SEARCHES) {
    return { error: `Höchstens ${MAX_SEARCHES} Suchen je Fakt. Urteile jetzt mit dem, was du hast (im Zweifel «unklar»).` };
  }
  st.searches++;
  let out;
  try {
    out = await searxng.search(query, { language: opts.language || '', signal: opts.signal });
  } catch (e) {
    if (e?.name === 'AbortError' && opts.signal?.aborted) throw e;
    return { error: 'Websuche nicht erreichbar. Ohne Beleg ist das Urteil «unklar».' };
  }
  for (const r of out.results) opts.evidence.add(r.url);
  // Keine Treffer, weil die Engines gesperrt sind (Rate-Limit, Captcha), ist ein
  // Ausfall, keine Fehlanzeige — sonst liest das Modell es als «dazu gibt es nichts».
  if (!out.results.length && out.unresponsive.length) {
    return { error: 'Suchdienst gerade gesperrt (keine Engine hat geantwortet). Ohne Beleg ist das Urteil «unklar».' };
  }
  return {
    query,
    treffer: out.results.map(r => ({
      titel: r.title, url: r.url,
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.published ? { datum: r.published } : {}),
    })),
  };
}

async function _readWebPage(input, st, opts) {
  const url = String(input?.url || '').trim();
  if (!normalizeUrl(url)) return { error: 'Nur http(s)-URLs.' };
  if (!opts.evidence.has(url)) return { error: 'Nur URLs aus den Treffern deiner Suche sind lesbar.' };
  if (st.reads >= MAX_PAGE_READS) return { error: `Höchstens ${MAX_PAGE_READS} Seite je Fakt.` };
  st.reads++;
  let page;
  try {
    page = await urlScrape.scrapeUrl(url, { allowPdf: true });
  } catch (e) {
    return { url, error: `Seite nicht lesbar (${e.code || 'Fehler'}). Stütze dich auf das Snippet.` };
  }
  if (page.finalUrl) opts.evidence.add(page.finalUrl);
  const text = String(page.text || '');
  return {
    url,
    titel: page.title || '',
    text: text.slice(0, PAGE_TEXT_MAX),
    ...(text.length > PAGE_TEXT_MAX ? { doc_truncated: true, doc_chars: text.length } : {}),
  };
}

const HANDLERS = { web_search: _webSearch, read_web_page: _readWebPage };

/**
 * Judge-Call eines Fakts mit SearXNG-Werkzeugen.
 *
 * @param {object} args
 *   messages0  Start-Nachrichten ([{ role:'user', content: prompt }])
 *   system     System-Prompt
 *   tools      FACTCHECK_WEB_TOOLS (aus den Prompts)
 *   provider   effektiver Provider (7. Arg von callTools)
 *   callTools  callAIWithTools (injizierbar)
 *   onCall(r)  bucht Tokens/Kosten jeder Runde (vom Job)
 *   evidence   makeEvidence()-Instanz dieses Fakts
 *   language   Suchsprache (Buchsprache)
 *   signal     Job-Abbruch
 *   maxTokensOut  für die Truncation-Meldung
 * @returns {Promise<string>} finaler Text (JSON-Urteil)
 */
async function judgeWithSearxng({ messages0, system, tools, provider, callTools, onCall, evidence, language, signal, maxTokensOut }) {
  const messages = [...messages0];
  const st = { searches: 0, reads: 0 };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const r = await callTools(messages, system, tools, null, null, signal, provider);
    onCall(r);
    if (r.truncated || r.stopReason === 'max_tokens') {
      const tokIn = r.tokensIn || 0;
      const tokOut = r.tokensOut || 0;
      throw i18nError('job.error.aiTruncated', { max: maxTokensOut, tokIn, tokOut, total: tokIn + tokOut });
    }
    const uses = r.stopReason === 'tool_use' ? (r.toolUses || []) : [];
    if (!uses.length) return r.text || '';
    // Letzte erlaubte Runde und noch Werkzeuge: es gibt kein Urteil.
    if (turn === MAX_TURNS - 1) throw i18nError('job.error.factcheckVerdictInvalid');
    messages.push({ role: 'assistant', content: r.rawContentBlocks });
    const results = [];
    for (const tu of uses) {
      const fn = HANDLERS[tu.name];
      const out = fn
        ? await fn(tu.parseError ? {} : tu.input, st, { evidence, language, signal })
        : { error: `Unbekanntes Werkzeug: ${tu.name}` };
      results.push({
        type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out),
        ...(out?.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  throw i18nError('job.error.factcheckVerdictInvalid');
}

module.exports = { judgeWithSearxng, makeEvidence, MAX_SEARCHES, MAX_PAGE_READS, MAX_TURNS };

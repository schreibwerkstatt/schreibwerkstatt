'use strict';
// Websuche als Function-Tools für den Recherche-Chat, wenn der Suchweg
// 'searxng' ist (lib/websearch#webSearchMode). Bei 'anthropic' sucht die API
// selbst (Server-Tool) und diese Handler werden nie gerufen.
//
//   web_search    { query }  → SearXNG-Treffer, global durchnummeriert (`nr`).
//                              Die Nummer ist die Position in ctx.web.results und
//                              damit dieselbe, über die das Frontend Belege `[nr]`
//                              auflöst (context_info.sources, 1-basiert).
//   read_web_page { url }    → Seitentext über lib/url-scrape (safeFetch: SSRF-Guard,
//                              die URL kommt vom Modell), gekappt + ausgewiesen.
//
// Der Suchdeckel liegt hier, nicht in der Werkzeugliste: ein Function-Tool kennt
// kein `max_uses`, und die Liste muss über den Lauf konstant bleiben (Prompt-Cache).
//
// read_web_page liest nur URLs bekannter Herkunft — Treffer dieses Laufs,
// Literatur-Treffer, Board-URLs des Buchs, Links aus der aktuellen User-Nachricht.
// Interne Ziele fängt der SSRF-Guard; diese Beschränkung verhindert Abfluss per
// Prompt-Injection (eine gelesene Seite weist das Modell an, eine fremde URL mit
// Buchinhalt im Query-String aufzurufen).
//
// ctx (vom Job gesetzt): bookId, jobSignal, logger, maxWebSearches, allowedDomains,
// searchLanguage, userMessageUrls, resultCapChars, pageResultCapChars, literatureHits.
// ctx.web wird hier angelegt: { searches, queries, results, pages }.

const searxng = require('../../lib/websearch/searxng');
const { cachedScrape, searchPdf, pdfReadText, withPdfPaging } = require('./research-pdf-paging');
const { normalizeUrl } = require('../../lib/url-normalize');
const { bookItemUrls } = require('../../db/research-items');
const { resultCapFor } = require('./book-chat-tools/shared');

const MAX_PAGE_READS = 6;
const PAGE_TEXT_MAX = 12000;
// Platz im Tool-Result neben dem Seitentext (Titel, URLs, Hinweise, JSON-Hülle).
const PAGE_OVERHEAD = 600;
const URL_RE = /https?:\/\/[^\s<>"'()\]]+/gi;

function webState(ctx) {
  if (!ctx.web) ctx.web = { searches: 0, queries: [], results: [], pages: [] };
  return ctx.web;
}

/** http(s)-URLs aus einem Freitext (User-Nachricht), Satzzeichen am Ende abgeschnitten. */
function extractUrls(text) {
  return (String(text || '').match(URL_RE) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
}

async function tool_web_search(input, ctx) {
  const query = String(input.query || input.q || '').trim();
  if (!query) return { error: 'query fehlt.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'query' } };
  const web = webState(ctx);
  const cap = Number(ctx.maxWebSearches) || 0;
  if (cap && web.searches >= cap) {
    return {
      error: `Suchdeckel erreicht (${cap} Suchen pro Antwort). Antworte jetzt mit den vorhandenen Treffern.`,
      errorKey: 'chat.toolError.webSearchCap', errorParams: { max: cap },
    };
  }
  web.searches++;
  web.queries.push(query);

  let out;
  try {
    out = await searxng.search(query, {
      domains: ctx.allowedDomains || [],
      language: ctx.searchLanguage || '',
      signal: ctx.jobSignal,
    });
  } catch (e) {
    if (e?.name === 'AbortError' && ctx.jobSignal?.aborted) throw e;
    ctx.logger?.warn?.(`[research-chat] Websuche fehlgeschlagen: ${e.message}`);
    return { error: 'Websuche nicht erreichbar. Antworte mit dem, was du hast, und sag, dass die Suche ausfiel.', errorKey: 'chat.toolError.serviceUnavailable' };
  }
  // Keine Treffer, weil die Engines gesperrt sind (Rate-Limit, Captcha), ist ein
  // Ausfall, keine Fehlanzeige — sonst liest das Modell es als «dazu gibt es nichts».
  if (!out.results.length && out.unresponsive.length) {
    return { error: 'Suchdienst gerade gesperrt (keine Suchmaschine hat geantwortet). Sag das in der Antwort, statt «nichts gefunden».', errorKey: 'chat.toolError.serviceUnavailable' };
  }

  const treffer = out.results.map((r) => {
    web.results.push({ url: r.url, title: r.title });
    return {
      nr: web.results.length,
      titel: r.title,
      url: r.url,
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.published ? { datum: r.published } : {}),
    };
  });
  const domains = (ctx.allowedDomains || []).filter(Boolean);
  return {
    query,
    treffer,
    ...(!treffer.length ? {
      hinweis: domains.length
        ? `Keine Treffer. Die Suche ist auf ${domains.join(', ')} eingegrenzt — das ist keine Fehlanzeige für das ganze Web.`
        : 'Keine Treffer. Formuliere die Suche anders, bevor du sagst, dass es nichts gibt.',
    } : {}),
  };
}

function _allowedPage(url, ctx) {
  const n = normalizeUrl(url);
  if (!n) return false;
  const web = webState(ctx);
  const known = [
    ...web.results.map(r => r.url),
    ...web.pages.map(p => p.url),
    ...(ctx.literatureHits || []).map(r => r.url),
    ...(ctx.userMessageUrls || []),
  ];
  if (known.some(u => normalizeUrl(u) === n)) return true;
  return bookItemUrls(ctx.bookId).some(u => normalizeUrl(u) === n);
}

// Anfang von `text`, dessen JSON-Form höchstens `max` Zeichen lang ist. Gemessen
// wird im JSON, weil die Deckel dahinter (truncateToolResult, Loop) das serialisierte
// Ergebnis zählen: eine Tabelle besteht zur Hälfte aus Zeilenumbrüchen, jeder wird
// zu `\n` — nach Zeichen gekappt läge sie über dem Deckel und die nächste Stufe
// schnitte sie grob zurück.
function _sliceForJson(text, max) {
  const fits = (n) => JSON.stringify(text.slice(0, n)).length - 2 <= max;
  let lo = 0, hi = Math.min(text.length, max);
  if (fits(hi)) return text.slice(0, hi);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo);
}

async function tool_read_web_page(input, ctx) {
  const url = String(input.url || '').trim();
  if (!url) return { error: 'url fehlt.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'url' } };
  if (!normalizeUrl(url)) return { error: 'Nur http(s)-URLs.', errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'url' } };
  if (!_allowedPage(url, ctx)) {
    return {
      error: 'URL stammt nicht aus einer bekannten Quelle. Lesbar sind nur Treffer von web_search/lookup_literature dieses Durchgangs, Links im Recherche-Board und Links aus der Nachricht des Users.',
      errorKey: 'chat.toolError.urlNotKnown',
    };
  }
  const web = webState(ctx);
  if (web.pages.length >= MAX_PAGE_READS) {
    return { error: `Höchstens ${MAX_PAGE_READS} Seiten pro Antwort.`, errorKey: 'chat.toolError.pageReadCap', errorParams: { max: MAX_PAGE_READS } };
  }

  let page;
  try {
    page = await cachedScrape(url, web);
  } catch (e) {
    ctx.logger?.info?.(`[research-chat] Seite nicht lesbar (${e.code || e.message}): ${url}`);
    return { url, error: `Seite nicht lesbar (${e.code || 'Fehler'}). Stütze dich auf das Snippet oder eine andere Quelle.`, errorKey: 'chat.toolError.serviceUnavailable' };
  }
  const finalUrl = page.finalUrl || url;
  web.pages.push({ url, title: page.title || url });
  if (normalizeUrl(finalUrl) !== normalizeUrl(url)) web.pages.push({ url: finalUrl, title: page.title || finalUrl });

  // PDF: Fundstellen statt Text (`suche`) bzw. Text ab einer Seite (`seite`) —
  // ./research-pdf-paging.js. Für HTML-Seiten ohne Wirkung.
  const suche = String(input.suche || '').trim();
  if (page.pdf && suche) {
    const { treffer, gesamt } = searchPdf(page.pdf.pageTexts || [], suche);
    return {
      url, titel: page.title || '', seiten: page.pdf.pages, suche, treffer, gesamt,
      hinweis: gesamt
        ? `Lies eine Fundstelle mit read_web_page und seite=<Seite>.${gesamt > treffer.length ? ` ${gesamt} Seiten mit Treffern, die ersten ${treffer.length} gezeigt.` : ''}`
        : 'Begriff im PDF nicht gefunden (andere Schreibweise? Gescanntes PDF ohne Textebene?).',
    };
  }
  const pdfView = pdfReadText(page, input.seite);

  // Deckel: höchstens PAGE_TEXT_MAX, und nie mehr, als der Loop pro Tool-Result
  // durchlässt — sonst schnitte der Loop still und die Kappung wäre unsichtbar.
  // Der Job setzt für Seiten einen eigenen, grösseren Loop-Deckel (pageResultCapChars,
  // research-chat.js#_pageResultCapChars); ohne ihn gilt der allgemeine.
  const loopCap = Number(ctx.pageResultCapChars) > 0 ? Number(ctx.pageResultCapChars) : resultCapFor(ctx);
  const max = Math.max(1000, Math.min(PAGE_TEXT_MAX, loopCap - PAGE_OVERHEAD));
  const text = pdfView ? pdfView.text : String(page.text || '');
  const shown = _sliceForJson(text, max);
  const truncated = shown.length < text.length;
  return withPdfPaging(pdfView, {
    url,
    ...(finalUrl !== url ? { final_url: finalUrl } : {}),
    titel: page.title || '',
    ...(page.published ? { datum: page.published } : {}),
    text: shown,
    doc_chars: text.length,
    doc_truncated: truncated,
    ...(truncated ? { hinweis: `Nur die ersten ${shown.length} von ${text.length} Zeichen.` } : {}),
    ...(!text.trim() ? { hinweis: 'Kein lesbarer Text (evtl. per Skript geladen oder nur Bilder).' } : {}),
  });
}

const WEB_TOOLS = {
  web_search: tool_web_search,
  read_web_page: tool_read_web_page,
};

module.exports = { WEB_TOOLS, extractUrls, MAX_PAGE_READS, PAGE_TEXT_MAX, PAGE_OVERHEAD };

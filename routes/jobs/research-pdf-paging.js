'use strict';
// Lange PDFs in `read_web_page` (Recherche-Chat, Suchweg SearXNG): ein 288-seitiger
// Tagungsband passt nicht in ein Tool-Result, und ohne Hilfe sieht das Modell nur
// den Anfang. Zwei optionale Parameter machen den Rest erreichbar:
//
//   seite  — Text ab dieser Seite, jede Seite mit Marke «[Seite N]». Ist der Text
//            gekappt, nennt das Ergebnis die Seite, ab der weiterzulesen ist.
//   suche  — Seiten, auf denen der Begriff steht, mit kurzem Auszug — statt Text.
//            Der Weg zu einer Stelle tief im Dokument: erst suchen, dann ab der
//            Fundseite lesen.
//
// Ohne Parameter liest ein PDF ab Seite 1 (mit Marken). Für HTML-Seiten ändert
// sich nichts. Das geholte Dokument wird je Lauf zwischengespeichert, damit Suchen
// und Weiterlesen nicht jedes Mal neu laden (ein grosses PDF braucht Sekunden).

const urlScrape = require('../../lib/url-scrape');
const { normalizeUrl } = require('../../lib/url-normalize');

const MAX_HITS = 10;
const HIT_CONTEXT = 120;

/** scrapeUrl mit Lauf-Cache (pro ctx.web, Schlüssel = normalisierte URL). */
function cachedScrape(url, web) {
  if (!web.scrapeCache) web.scrapeCache = new Map();
  const key = normalizeUrl(url) || url;
  if (!web.scrapeCache.has(key)) {
    const p = urlScrape.scrapeUrl(url, { allowPdf: true });
    // Ein Fehler soll nicht im Cache kleben (vorübergehender Timeout).
    p.catch(() => web.scrapeCache.delete(key));
    web.scrapeCache.set(key, p);
  }
  return web.scrapeCache.get(key);
}

function _pageNum(v, total) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, total));
}

/**
 * Seiten mit dem Suchbegriff (case-insensitiv) samt Auszug, höchstens MAX_HITS.
 * @returns {{ treffer: Array<{seite:number, auszug:string}>, gesamt: number }}
 */
function searchPdf(pageTexts, term) {
  const needle = String(term || '').trim().toLowerCase();
  const out = [];
  let gesamt = 0;
  if (!needle) return { treffer: out, gesamt };
  pageTexts.forEach((t, i) => {
    const hay = String(t || '');
    const at = hay.toLowerCase().indexOf(needle);
    if (at < 0) return;
    gesamt++;
    if (out.length >= MAX_HITS) return;
    const from = Math.max(0, at - HIT_CONTEXT);
    const to = Math.min(hay.length, at + needle.length + HIT_CONTEXT);
    out.push({
      seite: i + 1,
      auszug: `${from > 0 ? '…' : ''}${hay.slice(from, to).replace(/\s+/g, ' ').trim()}${to < hay.length ? '…' : ''}`,
    });
  });
  return { treffer: out, gesamt };
}

/**
 * Lesetext eines PDFs ab `seite`, jede Seite mit Marke. Für Nicht-PDFs null.
 * @returns {null | { text: string, abSeite: number, total: number }}
 */
function pdfReadText(page, seite) {
  const pages = page?.pdf?.pageTexts;
  if (!Array.isArray(pages)) return null;
  const total = pages.length;
  const abSeite = _pageNum(seite, total);
  const text = pages.slice(abSeite - 1).map((t, i) => `[Seite ${abSeite + i}]\n${t}`).join('\n\n');
  return { text, abSeite, total };
}

/**
 * Ergebnis von read_web_page um die PDF-Angaben ergänzen: Seitenzahl, Startseite
 * und — bei gekapptem Text — die Seite, ab der weiterzulesen ist (die letzte
 * angefangene Seite, sie kann unvollständig sein).
 */
function withPdfPaging(view, out) {
  if (!view) return out;
  const shown = String(out.text || '');
  const marks = [...shown.matchAll(/\[Seite (\d+)\]/g)].map(m => parseInt(m[1], 10));
  const last = marks.length ? marks[marks.length - 1] : view.abSeite;
  const next = out.doc_truncated ? last : null;
  return {
    ...out,
    seiten: view.total,
    ab_seite: view.abSeite,
    ...(next ? {
      weiter_ab_seite: next,
      hinweis: `PDF mit ${view.total} Seiten; gezeigt ab Seite ${view.abSeite} bis (teilweise) Seite ${last}. Weiterlesen: read_web_page mit seite=${next}. Eine bestimmte Stelle: read_web_page mit suche=<Begriff>.`,
    } : {}),
  };
}

module.exports = { cachedScrape, searchPdf, pdfReadText, withPdfPaging, MAX_HITS };

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

const _cacheKey = (url) => normalizeUrl(url) || url;

/** scrapeUrl mit Lauf-Cache (pro ctx.web, Schlüssel = normalisierte URL). Das
 *  Redirect-Ziel bekommt denselben Eintrag — wer es danach liest, holt nicht neu. */
function cachedScrape(url, web) {
  if (!web.scrapeCache) web.scrapeCache = new Map();
  const key = _cacheKey(url);
  if (!web.scrapeCache.has(key)) {
    const p = urlScrape.scrapeUrl(url, { allowPdf: true });
    // Ein Fehler soll nicht im Cache kleben (vorübergehender Timeout).
    p.then((page) => {
      const fin = page?.finalUrl ? _cacheKey(page.finalUrl) : null;
      if (fin && fin !== key && !web.scrapeCache.has(fin)) web.scrapeCache.set(fin, p);
    }, () => web.scrapeCache.delete(key));
    web.scrapeCache.set(key, p);
  }
  return web.scrapeCache.get(key);
}

/** Liegt das Dokument schon im Lauf-Cache (Folgeaufruf, kein neuer Abruf)? */
function isCached(url, web) {
  return !!web.scrapeCache?.has(_cacheKey(url));
}

function _pageNum(v, total) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(1, total));
}

// Suchform eines Seitentexts: Silbentrennung am Zeilenende aufgelöst
// («Geschichts-\nverein» → «Geschichtsverein»), aller Leerraum zu einem Blank —
// im PDF bricht jede Zeile, der gesuchte Begriff steht oft über zwei Zeilen.
const HYPHEN_EOL = /(\p{L})-[ \t]*\r?\n\s*(\p{L})/gu;
function _joinHyphens(s, keep) {
  return s.replace(HYPHEN_EOL, keep ? '$1-$2' : '$1$2');
}
function _flatten(s) {
  return s.replace(/\s+/g, ' ').trim();
}
function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Seiten mit dem Suchbegriff (case-insensitiv, Leerraum und Zeilenend-Trennung
 * egal) samt Auszug, höchstens MAX_HITS. Gesucht wird erst im Text mit
 * aufgelöster Trennung, dann mit erhaltenem Bindestrich — ein echter Bindestrich
 * am Zeilenende («Nord-\nSüd») bleibt so auffindbar. Der Auszug stammt aus derselben
 * normalisierten Fassung, in der der Treffer lag, damit die Position stimmt.
 * @returns {{ treffer: Array<{seite:number, auszug:string}>, gesamt: number }}
 */
function searchPdf(pageTexts, term) {
  const needle = _flatten(String(term || ''));
  const out = [];
  let gesamt = 0;
  if (!needle) return { treffer: out, gesamt };
  const re = new RegExp(_escRe(needle), 'iu');
  pageTexts.forEach((t, i) => {
    const raw = String(t || '');
    let hay = _flatten(_joinHyphens(raw, false));
    let m = re.exec(hay);
    if (!m) { hay = _flatten(_joinHyphens(raw, true)); m = re.exec(hay); }
    if (!m) return;
    gesamt++;
    if (out.length >= MAX_HITS) return;
    const at = m.index;
    const from = Math.max(0, at - HIT_CONTEXT);
    const to = Math.min(hay.length, at + m[0].length + HIT_CONTEXT);
    out.push({
      seite: i + 1,
      auszug: `${from > 0 ? '…' : ''}${hay.slice(from, to).trim()}${to < hay.length ? '…' : ''}`,
    });
  });
  return { treffer: out, gesamt };
}

/**
 * Lesetext eines PDFs ab `seite`, jede Seite mit Marke. Für Nicht-PDFs null.
 * `starts[i]` ist die Position der Marke von Seite abSeite+i im Text,
 * `requested` die verlangte Seite (für den Hinweis bei einer Seite hinter dem Ende).
 * @returns {null | { text: string, abSeite: number, total: number, starts: number[], requested: number|null }}
 */
function pdfReadText(page, seite) {
  const pages = page?.pdf?.pageTexts;
  if (!Array.isArray(pages)) return null;
  const total = pages.length;
  const abSeite = _pageNum(seite, total);
  const starts = [];
  let text = '';
  pages.slice(abSeite - 1).forEach((t, i) => {
    if (i) text += '\n\n';
    starts.push(text.length);
    text += `[Seite ${abSeite + i}]\n${t}`;
  });
  const req = parseInt(seite, 10);
  return { text, abSeite, total, starts, requested: Number.isFinite(req) ? req : null };
}

/**
 * PDF-Angaben zu einem Ergebnis, dessen Text die ersten `shownLen` Zeichen von
 * view.text zeigt: Seitenzahl, Startseite und — bei gekapptem Text — die Seite,
 * ab der weiterzulesen ist. Die zuletzt angefangene Seite gilt als unvollständig
 * und ist die Fortsetzung. Passt schon die Startseite nicht ganz in ein Ergebnis,
 * geht es mit der nächsten weiter (ihr Rest ist nur über `suche` erreichbar) —
 * `weiter_ab_seite` liegt so immer hinter `ab_seite`, ein Weiterlesen kommt nie
 * auf der Stelle zum Stehen. Für Nicht-PDFs null.
 */
function pdfPaging(view, shownLen) {
  if (!view) return null;
  const { abSeite, total, starts, requested } = view;
  const notes = [];
  if (requested && requested > total) notes.push(`Seite ${requested} gibt es nicht, das PDF hat ${total} Seiten; gezeigt ab Seite ${abSeite}.`);
  const meta = { seiten: total, ab_seite: abSeite };
  if (shownLen < view.text.length) {
    let idx = 0;
    while (idx + 1 < starts.length && starts[idx + 1] < shownLen) idx++;
    const last = abSeite + idx;
    if (idx > 0) {
      meta.weiter_ab_seite = last;
      notes.push(`PDF mit ${total} Seiten; gezeigt ab Seite ${abSeite} bis (teilweise) Seite ${last}. Weiterlesen: read_web_page mit seite=${last}. Eine bestimmte Stelle: read_web_page mit suche=<Begriff>.`);
    } else {
      const next = abSeite < total ? abSeite + 1 : null;
      if (next) meta.weiter_ab_seite = next;
      notes.push(`Seite ${abSeite} ist zu lang für ein Ergebnis und nur teilweise gezeigt; eine Stelle darin findest du mit suche=<Begriff>.${next ? ` Weiterlesen: read_web_page mit seite=${next}.` : ''}`);
    }
  }
  if (notes.length) meta.hinweis = notes.join(' ');
  return meta;
}

module.exports = { cachedScrape, isCached, searchPdf, pdfReadText, pdfPaging, MAX_HITS };

'use strict';
// Recherche-Chat, Suchweg SearXNG: Handler von web_search / read_web_page.
//  - web_search: globale Treffer-Nummern, Deckel ohne Netzwerkzugriff, Ausfall ≠ Fehlanzeige
//  - read_web_page: nur bekannte Herkunft, Kappung ausgewiesen, Redirect-Ziel gilt als belegt

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('rwt');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const searxng = require('../../lib/websearch/searxng');
const urlScrape = require('../../lib/url-scrape');
const { createItem } = require('../../db/research-items');
const { executeResearchTool } = require('../../routes/jobs/research-chat-tools');
const { extractUrls } = require('../../routes/jobs/research-web-tools');

const NOW = '2026-01-01T00:00:00.000Z';
const BOOK = 72001;
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK, NOW, NOW);

const realSearch = searxng.search;
const realScrape = urlScrape.scrapeUrl;
test.afterEach(() => { searxng.search = realSearch; urlScrape.scrapeUrl = realScrape; });

function mkCtx(extra = {}) {
  return { bookId: BOOK, maxWebSearches: 3, allowedDomains: [], literatureHits: [], userMessageUrls: [], ...extra };
}
function stubSearch(pages) {
  const calls = [];
  searxng.search = async (q, opts) => {
    calls.push({ q, opts });
    return { results: pages[calls.length - 1] || [], unresponsive: [] };
  };
  return calls;
}
const hit = (n) => ({ title: `T${n}`, url: `https://ex.com/${n}`, snippet: `S${n}`, engines: ['g'], published: null });

test('web_search: Treffer fortlaufend nummeriert, ctx.web gefüllt, Optionen durchgereicht', async () => {
  const calls = stubSearch([[hit(1), hit(2)], [hit(3)]]);
  const ctx = mkCtx({ allowedDomains: ['ex.com'], searchLanguage: 'de' });
  const a = await executeResearchTool('web_search', { query: 'eins' }, ctx);
  const b = await executeResearchTool('web_search', { query: 'zwei' }, ctx);
  assert.deepEqual(a.treffer.map(t => t.nr), [1, 2]);
  assert.deepEqual(b.treffer.map(t => t.nr), [3], 'Nummer läuft über Suchen hinweg weiter');
  assert.equal(ctx.web.searches, 2);
  assert.deepEqual(ctx.web.queries, ['eins', 'zwei']);
  assert.deepEqual(ctx.web.results.map(r => r.url), ['https://ex.com/1', 'https://ex.com/2', 'https://ex.com/3']);
  assert.deepEqual(calls[0].opts.domains, ['ex.com']);
  assert.equal(calls[0].opts.language, 'de');
});

test('web_search: Deckel erreicht → Fehler ohne Suche', async () => {
  const calls = stubSearch([[hit(1)], [hit(2)]]);
  const ctx = mkCtx({ maxWebSearches: 2 });
  await executeResearchTool('web_search', { query: 'a' }, ctx);
  await executeResearchTool('web_search', { query: 'b' }, ctx);
  const c = await executeResearchTool('web_search', { query: 'c' }, ctx);
  assert.equal(c.errorKey, 'chat.toolError.webSearchCap');
  assert.deepEqual(c.errorParams, { max: 2 });
  assert.equal(calls.length, 2);
  assert.equal(ctx.web.searches, 2);
});

test('web_search: leere Query, leere Treffer mit/ohne Eingrenzung, Dienst-Ausfall', async () => {
  const ctx = mkCtx();
  assert.equal((await executeResearchTool('web_search', { query: '  ' }, ctx)).errorKey, 'chat.toolError.missingParam');

  stubSearch([[]]);
  const leer = await executeResearchTool('web_search', { query: 'x' }, mkCtx({ allowedDomains: ['admin.ch'] }));
  assert.deepEqual(leer.treffer, []);
  assert.match(leer.hinweis, /admin\.ch eingegrenzt/);

  searxng.search = async () => { const e = new Error('down'); e.code = 'WEBSEARCH_UNAVAILABLE'; throw e; };
  const down = await executeResearchTool('web_search', { query: 'x' }, mkCtx());
  assert.equal(down.errorKey, 'chat.toolError.serviceUnavailable');
});

test('web_search: Job-Abbruch wird nicht verschluckt', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  searxng.search = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(executeResearchTool('web_search', { query: 'x' }, mkCtx({ jobSignal: ctrl.signal })), { name: 'AbortError' });
});

test('read_web_page: fremde URL abgelehnt, ohne Abruf', async () => {
  let fetched = 0;
  urlScrape.scrapeUrl = async () => { fetched++; return { text: 'x' }; };
  const r = await executeResearchTool('read_web_page', { url: 'https://evil.example/?d=geheim' }, mkCtx());
  assert.equal(r.errorKey, 'chat.toolError.urlNotKnown');
  assert.equal(fetched, 0);
});

test('read_web_page: erlaubte Herkünfte — Treffer, Literatur, Board, User-Nachricht', async () => {
  urlScrape.scrapeUrl = async (u) => ({ title: 'Seite', text: `Text von ${u}`, finalUrl: u });
  stubSearch([[hit(1)]]);
  const ctx = mkCtx({
    literatureHits: [{ url: 'https://doi.org/10.1/abc' }],
    userMessageUrls: extractUrls('Lies mal https://user.example/artikel, danke.'),
  });
  createItem({ bookId: BOOK, userEmail: 'u@example.com', kind: 'link', title: 'Board', urls: [{ url: 'https://board.example/x' }] });
  await executeResearchTool('web_search', { query: 'q' }, ctx);

  for (const url of ['http://www.ex.com/1/', 'https://doi.org/10.1/abc', 'https://user.example/artikel', 'https://board.example/x']) {
    const r = await executeResearchTool('read_web_page', { url }, ctx);
    assert.ok(!r.error, `${url}: ${r.error}`);
    assert.equal(r.titel, 'Seite');
  }
  assert.equal(ctx.web.pages.length, 4);
});

test('read_web_page: Kappung ausgewiesen, Redirect-Ziel als gelesene Seite vermerkt', async () => {
  urlScrape.scrapeUrl = async () => ({ title: 'Lang', text: 'a'.repeat(20000), finalUrl: 'https://ex.com/neu' });
  stubSearch([[hit(1)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.equal(r.doc_truncated, true);
  assert.equal(r.doc_chars, 20000);
  assert.ok(r.text.length <= 12000);
  assert.match(r.hinweis, /Nur die ersten/);
  assert.equal(r.final_url, 'https://ex.com/neu');
  assert.deepEqual(ctx.web.pages.map(p => p.url), ['https://ex.com/1', 'https://ex.com/neu']);
});

test('read_web_page: Seite nicht lesbar → Fehler mit Code, kein Wurf', async () => {
  urlScrape.scrapeUrl = async () => { const e = new Error('blocked'); e.code = 'SCRAPE_HTTP_ERROR'; throw e; };
  stubSearch([[hit(1)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.match(r.error, /SCRAPE_HTTP_ERROR/);
  assert.equal(ctx.web.pages.length, 0);
});

test('extractUrls: Satzzeichen am Ende ab, nur http(s)', () => {
  assert.deepEqual(extractUrls('Siehe https://a.ch/x. Und (http://b.de/y), ftp://c'), ['https://a.ch/x', 'http://b.de/y']);
  assert.deepEqual(extractUrls(''), []);
});

test('web_search: gesperrte Engines → Ausfall-Fehler statt leerer Trefferliste', async () => {
  searxng.search = async () => ({ results: [], unresponsive: ['brave: too many requests', 'duckduckgo: CAPTCHA'] });
  const ctx = mkCtx();
  const r = await executeResearchTool('web_search', { query: 'q' }, ctx);
  assert.equal(r.errorKey, 'chat.toolError.serviceUnavailable');
  assert.match(r.error, /gesperrt/);
  assert.equal(ctx.web.searches, 1, 'zählt als gelaufene Suche');
});

// ── PDFs: suche / seite / Weiterlesen ───────────────────────────────────────

function pdfPage(pageTexts, title = 'Tagungsband') {
  return { title, text: pageTexts.join('\n\n'), finalUrl: 'https://ex.com/1', pdf: { pages: pageTexts.length, truncated: false, pageTexts } };
}

async function ctxWithHit() {
  stubSearch([[hit(1)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  return ctx;
}

test('read_web_page PDF: suche liefert Fundseiten statt Text', async () => {
  const pages = ['Einleitung.', 'Nichts.', 'Der Getreidehandel Lübecks um 1835.', 'Mehr zum getreidehandel.'];
  urlScrape.scrapeUrl = async () => pdfPage(pages);
  const ctx = await ctxWithHit();
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'Getreidehandel' }, ctx);
  assert.equal(r.text, undefined, 'keine Volltextseiten');
  assert.equal(r.seiten, 4);
  assert.deepEqual(r.treffer.map(t => t.seite), [3, 4]);
  assert.match(r.treffer[0].auszug, /Getreidehandel Lübecks/);
  assert.match(r.hinweis, /seite=/);
});

test('read_web_page PDF: seite liest ab der Seite, mit Marken', async () => {
  urlScrape.scrapeUrl = async () => pdfPage(['A', 'B', 'C']);
  const ctx = await ctxWithHit();
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 2 }, ctx);
  assert.equal(r.text, '[Seite 2]\nB\n\n[Seite 3]\nC');
  assert.equal(r.ab_seite, 2);
  assert.equal(r.seiten, 3);
  assert.equal(r.weiter_ab_seite, undefined, 'vollständig gezeigt');
});

test('read_web_page PDF: gekappt → weiter_ab_seite zeigt auf die letzte angefangene Seite', async () => {
  const pages = Array.from({ length: 50 }, (_, i) => `Inhalt ${i + 1} `.repeat(40));
  urlScrape.scrapeUrl = async () => pdfPage(pages);
  const ctx = await ctxWithHit();
  ctx.resultCapChars = 3000;
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.equal(r.doc_truncated, true);
  assert.ok(r.weiter_ab_seite > 1 && r.weiter_ab_seite < 50, String(r.weiter_ab_seite));
  assert.ok(r.text.includes(`[Seite ${r.weiter_ab_seite}]`));
  assert.match(r.hinweis, new RegExp(`seite=${r.weiter_ab_seite}`));
  const next = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: r.weiter_ab_seite }, ctx);
  assert.ok(next.text.startsWith(`[Seite ${r.weiter_ab_seite}]`));
});

test('read_web_page: Dokument wird je Lauf nur einmal geholt; ungültige seite klemmt', async () => {
  let fetched = 0;
  urlScrape.scrapeUrl = async () => { fetched++; return pdfPage(['A', 'B']); };
  const ctx = await ctxWithHit();
  await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'B' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 99 }, ctx);
  assert.equal(fetched, 1);
  assert.equal(r.ab_seite, 2);
});

test('read_web_page HTML: seite/suche ohne Wirkung, keine PDF-Felder', async () => {
  urlScrape.scrapeUrl = async (u) => ({ title: 'Seite', text: 'Fliesstext.', finalUrl: u });
  const ctx = await ctxWithHit();
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 3, suche: 'x' }, ctx);
  assert.equal(r.text, 'Fliesstext.');
  assert.equal(r.seiten, undefined);
  assert.equal(r.treffer, undefined);
});

// ── Review-Befunde: Hülle, Fortsetzung, Suche, Lesedeckel, Sperre ───────────

test('read_web_page PDF: lange Hülle (Titel, URL) → Ergebnis passt in den Deckel, weiter_ab_seite passt zum Text', async () => {
  const longUrl = `https://ex.com/files/article-${'x'.repeat(400)}.pdf`;
  const pages = Array.from({ length: 40 }, (_, i) => `Seite ${i} Wort `.repeat(150));
  urlScrape.scrapeUrl = async () => ({
    title: `Hansische Geschichtsblätter ${'Band '.repeat(200)}`, text: '', finalUrl: `${longUrl}?token=abc`,
    pdf: { pages: 40, truncated: false, pageTexts: pages },
  });
  stubSearch([[{ ...hit(1), url: longUrl }]]);
  const ctx = mkCtx({ resultCapChars: 5000, pageResultCapChars: 12600 });
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: longUrl }, ctx);
  assert.ok(JSON.stringify(r).length <= 12600, String(JSON.stringify(r).length));
  assert.equal(r.truncated, undefined, 'keine nachgelagerte Kürzung');
  assert.ok(r.titel.length <= 300);
  const marks = [...r.text.matchAll(/\[Seite (\d+)\]/g)].map(m => Number(m[1]));
  assert.equal(r.weiter_ab_seite, marks.at(-1), 'Fortsetzung = letzte angefangene Seite im gelieferten Text');
  // Meta-Felder stehen vor dem Text (eine harte Kappung verliert sie nicht).
  const keys = Object.keys(r);
  assert.equal(keys.at(-1), 'text');
  assert.ok(keys.indexOf('weiter_ab_seite') < keys.indexOf('text'));
});

test('read_web_page HTML: Hinweis nennt die tatsächlich gelieferte Länge', async () => {
  urlScrape.scrapeUrl = async () => ({ title: 'T'.repeat(5000), text: 'a'.repeat(30000), finalUrl: 'https://ex.com/1' });
  const ctx = await ctxWithHit();
  ctx.pageResultCapChars = 6000;
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.ok(JSON.stringify(r).length <= 6000);
  assert.equal(r.hinweis, `Nur die ersten ${r.text.length} von 30000 Zeichen.`);
});

test('read_web_page PDF: Einzelseite länger als der Deckel → Fortsetzung auf der nächsten Seite, nie auf der Stelle', async () => {
  urlScrape.scrapeUrl = async () => pdfPage(['kurz', 'A'.repeat(5000), 'drei', 'ende']);
  const ctx = await ctxWithHit();
  ctx.resultCapChars = 4000;
  ctx.pageResultCapChars = 4000;
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 2 }, ctx);
  assert.equal(r.ab_seite, 2);
  assert.equal(r.weiter_ab_seite, 3);
  assert.match(r.hinweis, /Seite 2 ist zu lang/);
  const last = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 4 }, ctx);
  assert.equal(last.weiter_ab_seite, undefined);
  // Letzte Seite überlang: keine Fortsetzung, aber Hinweis.
  urlScrape.scrapeUrl = async () => pdfPage(['A'.repeat(5000)]);
  const ctx2 = await ctxWithHit();
  ctx2.pageResultCapChars = 4000;
  const one = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx2);
  assert.equal(one.weiter_ab_seite, undefined);
  assert.equal(one.doc_truncated, true);
});

test('read_web_page PDF: seite hinter dem Ende → Hinweis', async () => {
  urlScrape.scrapeUrl = async () => pdfPage(['A', 'B']);
  const ctx = await ctxWithHit();
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 9 }, ctx);
  assert.equal(r.ab_seite, 2);
  assert.match(r.hinweis, /Seite 9 gibt es nicht, das PDF hat 2 Seiten/);
});

test('read_web_page PDF: suche findet Begriffe über Zeilenumbruch und Silbentrennung', async () => {
  const pages = ['Der Hansische\nGeschichtsverein tagte.', 'Der Geschichts-\nverein zu Lübeck.', 'Nord-\nSüd-Achse.'];
  urlScrape.scrapeUrl = async () => pdfPage(pages);
  const ctx = await ctxWithHit();
  const a = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'Hansische  Geschichtsverein' }, ctx);
  assert.deepEqual(a.treffer.map(t => t.seite), [1]);
  assert.match(a.treffer[0].auszug, /Der Hansische Geschichtsverein tagte/);
  const b = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'geschichtsverein zu' }, ctx);
  assert.deepEqual(b.treffer.map(t => t.seite), [2]);
  assert.match(b.treffer[0].auszug, /Geschichtsverein zu Lübeck/);
  const c = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'Nord-Süd' }, ctx);
  assert.deepEqual(c.treffer.map(t => t.seite), [3]);
});

test('read_web_page: Lesedeckel zählt Abrufe — Redirect nicht doppelt, Folgeaufrufe aufs gecachte PDF gar nicht', async () => {
  let fetched = 0;
  urlScrape.scrapeUrl = async (u) => {
    fetched++;
    if (u.includes('/1')) return { ...pdfPage(['A', 'B']), finalUrl: 'https://ex.com/1-neu' };
    return { title: 'S', text: 'x', finalUrl: u };
  };
  stubSearch([Array.from({ length: 8 }, (_, i) => hit(i + 1))]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  for (let i = 0; i < 4; i++) await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 2 }, ctx);
  await executeResearchTool('read_web_page', { url: 'https://ex.com/1', suche: 'B' }, ctx);
  // Das Redirect-Ziel liegt schon im Cache: lesbar, ohne neuen Abruf.
  const viaFinal = await executeResearchTool('read_web_page', { url: 'https://ex.com/1-neu' }, ctx);
  assert.ok(!viaFinal.error, viaFinal.error);
  assert.equal(fetched, 1);
  assert.equal(ctx.web.fetches, 1);
  assert.deepEqual(ctx.web.pages.map(p => p.url), ['https://ex.com/1', 'https://ex.com/1-neu'], 'Belege: URL + Redirect-Ziel, je einmal');
  for (const n of [2, 3, 4, 5, 6]) {
    const r = await executeResearchTool('read_web_page', { url: `https://ex.com/${n}` }, ctx);
    assert.ok(!r.error, `${n}: ${r.error}`);
  }
  const over = await executeResearchTool('read_web_page', { url: 'https://ex.com/7' }, ctx);
  assert.equal(over.errorKey, 'chat.toolError.pageReadCap');
  assert.match(over.error, /Dokumente/);
  const again = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 1 }, ctx);
  assert.ok(!again.error, 'Weiterlesen im gecachten PDF geht über dem Deckel weiter');
});

test('web_search: eine gesperrte Engine neben Rohtreffern ist kein Ausfall — Eingrenzungs-Hinweis bleibt', async () => {
  searxng.search = async () => ({ results: [], unresponsive: ['brave: too many requests'], rawCount: 5 });
  const ctx = mkCtx({ allowedDomains: ['zeit.de'] });
  const r = await executeResearchTool('web_search', { query: 'q' }, ctx);
  assert.equal(r.error, undefined);
  assert.match(r.hinweis, /eingegrenzt/);
  assert.equal(searxng.searchBlocked({ results: [], unresponsive: ['x'], rawCount: 0 }), true);
  assert.equal(searxng.searchBlocked({ results: [], unresponsive: [], rawCount: 0 }), false);
  assert.equal(searxng.searchBlocked({ results: [hit(1)], unresponsive: ['x'], rawCount: 1 }), false);
});

// ── Abgerufen wird die gespeicherte URL, nie die Modell-Fassung ──────────────
test('read_web_page: utm/fbclid-, www- und http-Varianten holen die gespeicherte Treffer-URL', async () => {
  const fetchedUrls = [];
  urlScrape.scrapeUrl = async (u) => { fetchedUrls.push(u); return { title: 'S', text: 'x', finalUrl: u }; };
  searxng.search = async () => ({ results: [{ title: 'T', url: 'https://www.ex.com/artikel', snippet: '' }], unresponsive: [] });
  const variants = [
    'https://www.ex.com/artikel?utm_source=GEHEIMER-MANUSKRIPTTEXT',
    'http://ex.com/artikel?fbclid=leak',
    'https://ex.com/artikel/',
  ];
  for (const v of variants) {
    const ctx = mkCtx();
    await executeResearchTool('web_search', { query: 'q' }, ctx);
    const r = await executeResearchTool('read_web_page', { url: v }, ctx);
    assert.ok(!r.error, r.error);
    assert.equal(r.url, 'https://www.ex.com/artikel', 'Ergebnis nennt die gespeicherte URL');
    assert.deepEqual(ctx.web.pages.map(p => p.url), ['https://www.ex.com/artikel']);
  }
  assert.deepEqual(fetchedUrls, Array(3).fill('https://www.ex.com/artikel'), 'nie der Modell-String');
  assert.ok(!fetchedUrls.some(u => /GEHEIM|leak/.test(u)));
});

test('read_web_page: User- und Board-URL — abgerufen wird der gespeicherte String', async () => {
  const fetchedUrls = [];
  urlScrape.scrapeUrl = async (u) => { fetchedUrls.push(u); return { title: 'S', text: 'x', finalUrl: u }; };
  const id = createItem({ bookId: BOOK, userEmail: 'u@example.com', kind: 'link', title: 'Board', urls: [{ url: 'https://board.example.org/a', label: '' }] });
  assert.ok(id);
  const ctx = mkCtx({ userMessageUrls: ['https://user.example.org/x'] });
  await executeResearchTool('read_web_page', { url: 'https://user.example.org/x?utm_campaign=x' }, ctx);
  await executeResearchTool('read_web_page', { url: 'http://www.board.example.org/a?gclid=1' }, ctx);
  assert.deepEqual(fetchedUrls, ['https://user.example.org/x', 'https://board.example.org/a']);
});

test('read_web_page: gescheiterte Abrufe zählen in den Lesedeckel', async () => {
  let fetched = 0;
  urlScrape.scrapeUrl = async () => { fetched++; const e = new Error('t'); e.code = 'SCRAPE_TIMEOUT'; throw e; };
  stubSearch([Array.from({ length: 8 }, (_, i) => hit(i + 1))]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  for (let n = 1; n <= 6; n++) {
    const r = await executeResearchTool('read_web_page', { url: `https://ex.com/${n}` }, ctx);
    assert.equal(r.errorKey, 'chat.toolError.serviceUnavailable');
  }
  assert.equal(ctx.web.fetches, 6);
  const over = await executeResearchTool('read_web_page', { url: 'https://ex.com/7' }, ctx);
  assert.equal(over.errorKey, 'chat.toolError.pageReadCap');
  assert.equal(fetched, 6, 'der siebte Versuch geht nicht hinaus');
});

test('read_web_page: Byte-Budget je Antwort — Rest als Deckel, danach errorKey', async () => {
  const { MAX_FETCH_BYTES } = require('../../routes/jobs/research-web-tools');
  const opts = [];
  urlScrape.scrapeUrl = async (u, o) => { opts.push(o); return { title: 'S', text: 'x', finalUrl: u, bytes: MAX_FETCH_BYTES - 1000 }; };
  stubSearch([[hit(1), hit(2), hit(3)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  // Erster Abruf: höchstens ein Dokument-Deckel (lib/url-scrape#MAX_PDF_BYTES).
  assert.equal(opts[0].maxBytes, Math.min(MAX_FETCH_BYTES, urlScrape.MAX_PDF_BYTES));
  urlScrape.scrapeUrl = async (u, o) => { opts.push(o); return { title: 'S', text: 'x', finalUrl: u, bytes: 1000 }; };
  await executeResearchTool('read_web_page', { url: 'https://ex.com/2' }, ctx);
  assert.equal(opts[1].maxBytes, 1000, 'zweiter Abruf bekommt nur den Rest');
  const over = await executeResearchTool('read_web_page', { url: 'https://ex.com/3' }, ctx);
  assert.equal(over.errorKey, 'chat.toolError.pageBytesCap');
  assert.equal(opts.length, 2);
  // Schon geholtes Dokument bleibt lesbar.
  const again = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.ok(!again.error, again.error);
});

test('read_web_page PDF: Text nach dem Zeichendeckel gekappt → seiten = echte Zahl, Hinweis bei Seite dahinter', async () => {
  urlScrape.scrapeUrl = async () => ({ ...pdfPage(['A', 'B']), pdf: { pages: 50, truncated: true, pageTexts: ['A', 'B'] } });
  const ctx = await ctxWithHit();
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1', seite: 30 }, ctx);
  assert.equal(r.seiten, 50);
  assert.equal(r.text_bis_seite, 2);
  assert.match(r.hinweis, /nach Seite 2 gekappt/);
});

test('extractUrls: Klammern in der URL bleiben, Markdown-Link und Klammer-Einschub korrekt', () => {
  assert.deepEqual(
    extractUrls('Siehe [Wiki](https://de.wikipedia.org/wiki/Foo_(Bar)). Oder (vgl. https://ex.com/a), dazu https://ex.com/b?x=(1)! Ende: https://ex.com/c.'),
    ['https://de.wikipedia.org/wiki/Foo_(Bar)', 'https://ex.com/a', 'https://ex.com/b?x=(1)', 'https://ex.com/c'],
  );
  assert.deepEqual(extractUrls('[Text](https://ex.com/d)'), ['https://ex.com/d']);
  assert.deepEqual(extractUrls('«https://ex.com/e»'), ['https://ex.com/e']);
});

test('read_web_page: gescheiterter Abruf rechnet die geladenen Bytes ins Budget', async () => {
  const { MAX_FETCH_BYTES } = require('../../routes/jobs/research-web-tools');
  urlScrape.scrapeUrl = async () => { const e = new Error('pdf'); e.code = 'SCRAPE_PDF_UNREADABLE'; e.bytes = MAX_FETCH_BYTES; throw e; };
  stubSearch([[hit(1), hit(2)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.equal(r.errorKey, 'chat.toolError.serviceUnavailable');
  assert.equal(ctx.web.bytes, MAX_FETCH_BYTES);
  const over = await executeResearchTool('read_web_page', { url: 'https://ex.com/2' }, ctx);
  assert.equal(over.errorKey, 'chat.toolError.pageBytesCap');
});

test('read_web_page: Job-Signal geht an den Abruf, Abbruch wird nicht verschluckt', async () => {
  const ctrl = new AbortController();
  let seen = null;
  urlScrape.scrapeUrl = async (_u, o) => {
    seen = o.signal;
    ctrl.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  stubSearch([[hit(1)]]);
  const ctx = mkCtx({ jobSignal: ctrl.signal });
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  await assert.rejects(executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx), (e) => e.name === 'AbortError');
  assert.equal(seen, ctrl.signal);
});

test('read_web_page: Archiv-URLs werden je Lauf einmal gelesen (URL-Index)', async () => {
  const { syncUrlIndex } = require('../../routes/jobs/research-url-index');
  const ctx = mkCtx();
  createItem({ bookId: BOOK, userEmail: 'u@example.com', kind: 'link', title: 'Idx', urls: [{ url: 'https://idx.example.org/a', label: '' }] });
  const m1 = syncUrlIndex(ctx);
  assert.ok([...m1.values()].includes('https://idx.example.org/a'));
  createItem({ bookId: BOOK, userEmail: 'u@example.com', kind: 'link', title: 'Idx2', urls: [{ url: 'https://idx.example.org/b', label: '' }] });
  const m2 = syncUrlIndex(ctx);
  assert.ok(![...m2.values()].includes('https://idx.example.org/b'), 'Archiv nur beim ersten Aufruf gelesen');
  ctx.userMessageUrls.push('https://neu.example.org/x');
  assert.ok([...syncUrlIndex(ctx).values()].includes('https://neu.example.org/x'), 'neue Lauf-URLs kommen dazu');
});

test('web_search parallel: Treffernummern in Aufrufreihenfolge, auch wenn die zweite Suche zuerst antwortet', async () => {
  const delays = { eins: 30, zwei: 0 };
  searxng.search = async (q) => {
    await new Promise(r => setTimeout(r, delays[q]));
    return { results: q === 'eins' ? [hit(1), hit(2)] : [hit(3)], unresponsive: [] };
  };
  const ctx = mkCtx();
  const [a, b] = await Promise.all([
    executeResearchTool('web_search', { query: 'eins' }, ctx),
    executeResearchTool('web_search', { query: 'zwei' }, ctx),
  ]);
  assert.deepEqual(a.treffer.map(t => t.nr), [1, 2]);
  assert.deepEqual(b.treffer.map(t => t.nr), [3]);
  assert.deepEqual(ctx.web.results.map(r => r.url), ['https://ex.com/1', 'https://ex.com/2', 'https://ex.com/3']);
});

test('web_search parallel: eine gescheiterte Suche hält die Reihenfolge der übrigen nicht auf', async () => {
  searxng.search = async (q) => {
    if (q === 'kaputt') { await new Promise(r => setTimeout(r, 10)); throw new Error('down'); }
    await new Promise(r => setTimeout(r, q === 'eins' ? 20 : 0));
    return { results: q === 'eins' ? [hit(1)] : [hit(2)], unresponsive: [] };
  };
  const ctx = mkCtx();
  const [a, x, b] = await Promise.all([
    executeResearchTool('web_search', { query: 'eins' }, ctx),
    executeResearchTool('web_search', { query: 'kaputt' }, ctx),
    executeResearchTool('web_search', { query: 'zwei' }, ctx),
  ]);
  assert.ok(x.error);
  assert.deepEqual([a.treffer[0].nr, b.treffer[0].nr], [1, 2]);
});

test('read_web_page parallel: gleichzeitige Abrufe teilen das Byte-Budget statt es je ganz zu sehen', async () => {
  const { MAX_FETCH_BYTES } = require('../../routes/jobs/research-web-tools');
  const opts = [];
  urlScrape.scrapeUrl = async (u, o) => {
    opts.push(o);
    await new Promise(r => setTimeout(r, 5));
    return { title: 'S', text: 'x', finalUrl: u, bytes: 10 };
  };
  stubSearch([[hit(1), hit(2), hit(3)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  await Promise.all([1, 2, 3].map(n => executeResearchTool('read_web_page', { url: `https://ex.com/${n}` }, ctx)));
  const total = opts.reduce((a, o) => a + o.maxBytes, 0);
  assert.ok(total <= MAX_FETCH_BYTES, `Summe der Deckel ${total} > Budget ${MAX_FETCH_BYTES}`);
  assert.equal(ctx.web.bytesReserved, 0, 'Reservierung nach den Abrufen wieder frei');
});

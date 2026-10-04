'use strict';
// Seed-Helper für Integration-Tests. Spielt die Dummy-Buch-Fixture
// (tests/fixtures/dummy-book.md, 4 Kapitel × 2 Seiten) via db-seed in die
// Test-SQLite ein, damit Pipeline-Tests reproduzierbar gegen echte Prosa laufen.
//
// IDs sind deterministisch aus bookId abgeleitet:
//   chapter_id = bookId * 1000 + chapterIndex     (z.B. 102001..102004)
//   page_id    = bookId * 1000 + chapterIndex*10 + pageIndex  (z.B. 102011, 102012, 102021, …)
// Damit lassen sich Asserts „page 1.1 hat page_id 102011" stabil ausdrücken.

const { parseDummyBook, META } = require('../../fixtures/dummy-book-loader');

const PAGE_UPDATED_AT = '2026-04-20T12:44:47.000000Z';

function _mdToHtml(md) {
  // Pipeline strippt HTML-Tags zu Text. Paragraph-Boundaries reichen — keine
  // echte Markdown→HTML-Konvertierung nötig. Leerzeilen-trennt → <p>-Blöcke.
  return md
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, ' ')}</p>`)
    .join('\n');
}

function buildDummyBookFixture(bookId) {
  if (!Number.isInteger(bookId) || bookId <= 0) {
    throw new Error('buildDummyBookFixture: bookId muss positive Ganzzahl sein');
  }
  const { chapters: parsedChapters } = parseDummyBook();
  const chapters = [];
  const pages = [];
  const pageBodies = {};
  const idMap = { chapters: {}, pages: {} };

  parsedChapters.forEach((chap, ci) => {
    const chapIndex = ci + 1;
    const chapterId = bookId * 1000 + chapIndex;
    chapters.push({
      id: chapterId,
      book_id: bookId,
      name: chap.title,
      updated_at: PAGE_UPDATED_AT,
      position: chapIndex,
    });
    idMap.chapters[chapIndex] = chapterId;

    chap.pages.forEach((page, pi) => {
      const pageIndex = pi + 1;
      const pageId = bookId * 1000 + chapIndex * 10 + pageIndex;
      pages.push({
        id: pageId,
        book_id: bookId,
        chapter_id: chapterId,
        name: page.title,
        updated_at: PAGE_UPDATED_AT,
        position: pageIndex,
      });
      pageBodies[pageId] = _mdToHtml(page.markdown);
      idMap.pages[`${chapIndex}.${pageIndex}`] = pageId;
    });
  });

  const books = [{
    id: bookId,
    name: META.title,
    slug: 'der-nebel-uber-luzern',
    description: 'Dummy-Krimi, Integration-Test-Fixture.',
    updated_at: PAGE_UPDATED_AT,
    created_at: PAGE_UPDATED_AT,
  }];

  return { chapters, pages, pageBodies, books, idMap, meta: META };
}

function seedDummyBook(dbSeed, bookId) {
  const fixture = buildDummyBookFixture(bookId);
  dbSeed.setBook({
    chapters: fixture.chapters,
    pages: fixture.pages,
    pageBodies: fixture.pageBodies,
    books: fixture.books,
  });
  return fixture;
}

// Komplettanalyse-AI-Mocks mit realistischen Namen aus dem Dummy-Buch.
// Reicht für Pipeline-Smoke (Schema-Validierung, Speicherung, Counts).
const DUMMY_FIGUREN = Object.freeze([
  { id: 'fig_lea', name: 'Lea Brunner', kurzname: 'Brunner', typ: 'hauptfigur',
    beschreibung: 'Kommissarin, Ich-Erzählerin', sozialschicht: 'mittelschicht', praesenz: 'zentral' },
  { id: 'fig_markus', name: 'Markus Keller', kurzname: 'Keller', typ: 'nebenfigur',
    beschreibung: 'Partner von Brunner', sozialschicht: 'mittelschicht', praesenz: 'regelmaessig' },
  { id: 'fig_sibylle', name: 'Sibylle Amrein', kurzname: 'Amrein', typ: 'nebenfigur',
    beschreibung: 'Erstes Mordopfer, 35, Kanzlei-Assistentin', sozialschicht: 'mittelschicht', praesenz: 'punktuell' },
  { id: 'fig_ronnie', name: 'Ronnie Huber', kurzname: 'Röschti', typ: 'nebenfigur',
    beschreibung: 'Informant, zweites Opfer', sozialschicht: 'prekariat', praesenz: 'punktuell' },
  { id: 'fig_moser', name: 'Daniel Moser', kurzname: 'Moser', typ: 'antagonist',
    beschreibung: 'Hauptverdächtiger', sozialschicht: 'gehobenes_buergertum', praesenz: 'punktuell' },
]);

const DUMMY_ORTE = Object.freeze([
  { id: 'ort_seeufer', name: 'Seeufer Weggis', typ: 'natur', beschreibung: 'Fundort Sibylle' },
  { id: 'ort_buero',   name: 'Polizei-Büro Kasimir-Pfyffer-Strasse', typ: 'arbeit', beschreibung: 'Brunners Büro' },
  { id: 'ort_schweizerhof', name: 'Hotel Schweizerhof', typ: 'gebaeude', beschreibung: 'Bar-Treffpunkt' },
  { id: 'ort_bahnhof', name: 'Bahnhof Luzern', typ: 'gebaeude', beschreibung: 'Treff mit Ronnie' },
]);

// Kombinierter Extraktions-Output (lokale Provider / Multi-Pass-Kombi-Schema).
function _extraktionResponse(chapterName) {
  return {
    figuren: DUMMY_FIGUREN.map(f => ({
      ...f,
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      beziehungen: [], eigenschaften: [], schluesselzitate: [],
    })),
    orte: DUMMY_ORTE.map(o => ({
      ...o,
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      figuren_namen: ['Lea Brunner'],
    })),
    fakten: [
      { kategorie: 'opfer', subjekt: 'Sibylle Amrein', fakt: 'tot am Seeufer', seite: 'Seite 1.1' },
    ],
    szenen: [{
      seite: 'Seite', kapitel: chapterName, titel: 'Szene',
      wertung: 'mittel', kommentar: '',
      figuren_namen: ['Lea Brunner'], orte_namen: ['Seeufer Weggis'],
    }],
    assignments: [{ figur_name: 'Lea Brunner', lebensereignisse: [] }],
  };
}

// Claude-Single-Pass A1: Figuren-Stammdaten (figuren + assignments, KEIN orte).
function _figurenStammResponse(chapterName) {
  return {
    figuren: DUMMY_FIGUREN.map(f => ({
      ...f,
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      eigenschaften: [], schluesselzitate: [],
    })),
    assignments: [{ figur_name: 'Lea Brunner', lebensereignisse: [] }],
  };
}

// Claude-Single-Pass B: Orte + Songs + Szenen (KEINE figuren; Fakten laufen über Call C).
function _ortePassResponse(chapterName) {
  return {
    orte: DUMMY_ORTE.map(o => ({
      ...o,
      kapitel: [{ name: chapterName, haeufigkeit: 1 }],
      figuren_namen: ['Lea Brunner'],
    })),
    songs: [],
    szenen: [{
      seite: 'Seite', kapitel: chapterName, titel: 'Szene',
      wertung: 'mittel', kommentar: '',
      figuren_namen: ['Lea Brunner'], orte_namen: ['Seeufer Weggis'],
    }],
  };
}

// Claude-Single-Pass C: nur Fakten (eigener Call).
function _faktenPassResponse() {
  return {
    fakten: [
      { kategorie: 'opfer', subjekt: 'Sibylle Amrein', fakt: 'tot am Seeufer', seite: 'Seite 1.1' },
    ],
  };
}

function registerKomplettAiMocks(mockAi) {
  const chapterFromPrompt = (prompt) => {
    const m = prompt.match(/Kapitel \d+[^\n]*/);
    return m ? m[0].trim() : 'Kapitel';
  };
  // A1: Figuren-Stammdaten (figuren + assignments, KEIN orte).
  mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    ({ prompt }) => _figurenStammResponse(chapterFromPrompt(prompt)),
  );
  // B: Orte/Szenen (orte + szenen, KEINE figuren).
  mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ({ prompt }) => _ortePassResponse(chapterFromPrompt(prompt)),
  );
  // C: Fakten (nur fakten).
  mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('fakten'),
    _faktenPassResponse(),
  );
  // Kombiniertes Extraktions-Schema (lokale Provider / Multi-Pass-Kombi).
  mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('orte') && e.schemaKeys.includes('assignments'),
    ({ prompt }) => _extraktionResponse(chapterFromPrompt(prompt)),
  );
  // Konsolidierung Figuren (Multi-Pass).
  mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('figuren'),
    {
      figuren: DUMMY_FIGUREN.map(f => ({
        ...f,
        kapitel: [{ name: 'Kapitel 1 — Der Fund', haeufigkeit: 1 }],
        beziehungen: [], eigenschaften: [], schluesselzitate: [],
      })),
    },
  );
  // Konsolidierung Orte (Multi-Pass).
  mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('orte'),
    {
      orte: DUMMY_ORTE.map(o => ({
        ...o,
        kapitel: [{ name: 'Kapitel 1 — Der Fund', haeufigkeit: 1 }],
        figuren_namen: ['Lea Brunner'],
      })),
    },
  );
  // Phase 3b kapitelübergreifende Beziehungen.
  mockAi.on(
    (e) => e.schemaKeys.includes('beziehungen') && !e.schemaKeys.includes('figuren'),
    { beziehungen: [] },
  );
  // Phase 8 Kontinuitätscheck.
  mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    {
      zusammenfassung: 'Mehrere Widersprüche entdeckt.',
      probleme: [
        { typ: 'detail', schweregrad: 'mittel', beschreibung: 'Augenfarbe Sibylle Amrein: blau (1.1) vs. braun (3.1).' },
        { typ: 'ort',    schweregrad: 'mittel', beschreibung: 'Fundort: Weggis (1.1) vs. Vitznau (3.1).' },
      ],
    },
  );
}

module.exports = {
  buildDummyBookFixture,
  seedDummyBook,
  registerKomplettAiMocks,
  DUMMY_FIGUREN,
  DUMMY_ORTE,
  META,
};

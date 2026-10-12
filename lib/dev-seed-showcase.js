// Formatierungs-Schaukasten im Devmode-Testbuch: ein Abschnitt, der jede
// Formatierung des Notebook-Editors einmal enthaelt — Inline-Auszeichnung,
// Quellenangabe, Querverweis und jeden Blocktyp aus dem Slash-Menue.
//
// Laeuft bei JEDEM Start in LOCAL_DEV_MODE (nicht nur auf leerer DB wie
// lib/dev-seed.js) und gleicht den Abschnitt mit der Vorlage hier ab: fehlt er,
// wird er angelegt; weicht sein Inhalt von der Vorlage ab, wird er
// ueberschrieben. Haendische Aenderungen am Schaukasten ueberleben deshalb den
// naechsten Neustart nicht — er ist Anschauung, kein Arbeitsabschnitt.
//
// Neuer Blocktyp im Slash-Menue ⇒ hier ins Markup UND in SHOWCASE_SELECTORS
// eintragen. Gegated durch tests/unit/dev-seed-showcase.test.mjs.
//
// Abschalten: LOCAL_DEV_SEED=false oder LOCAL_DEV_SEED_SHOWCASE=false (die
// gebootete Test-App tut das, damit ihre Specs ein festes Buch sehen).

const crypto = require('crypto');
const { db } = require('../db/connection');
const store = require('./content-store');
const sources = require('../db/sources/pool');
const { linkSource } = require('../db/sources/links');
const { insertPageImage, getPageImage } = require('../db/page-images');
const { cleanPageHtml, ensureBlockIds } = require('./html-clean');
const logger = require('../logger');

const DEV_OWNER = 'dev@local';
const BOOK_NAME = 'Devmode-Testbuch';
const CHAPTER_NAME = 'Kapitel 1';
const PAGE_NAME = 'Formatierungen (alle)';
const XREF_CHAPTER_NAME = 'Kapitel 2';
const XREF_PAGE_NAME = 'Familie';
const SOURCE_TITLE = 'Die Verwandlung';

// Abbildung und Tabelle brauchen feste Block-IDs, weil Querverweise auf sie zeigen.
const FIG_BID = 'f1a2b3c4d5e6f7a8';
const TAB_BID = 'a8b7c6d5e4f3a2b1';

// Slash-Menue-Key → Selektor, der im Schaukasten treffen muss. Keys ohne Markup
// (Datums-/Zeitstempel = reiner Text, „teilen" = Aktion) stehen in
// SHOWCASE_EXEMPT. Der Test prueft: jeder SLASH_ITEMS-Key steht in genau einer
// der beiden Listen, und jeder Selektor trifft.
const SHOWCASE_SELECTORS = {
  paragraph: 'p',
  h2: 'h2',
  h3: 'h3',
  blockquote: 'blockquote',
  poem: 'div.poem',
  msgthread: 'div.msg-thread',
  list: 'ul:not(.todo)',
  olist: 'ol',
  todo: 'ul.todo',
  hr: 'hr:not([class])',
  pagebreak: 'hr.pagebreak',
  blankpage: 'hr.blankpage',
  bild: 'figure img',
  diagramm: 'pre.mermaid',
  tabelle: 'table',
};
const SHOWCASE_EXEMPT = ['heute', 'jetzt', 'zeit', 'teilen'];

// Was nicht im Slash-Menue steht, aber trotzdem gezeigt wird.
const SHOWCASE_INLINE_SELECTORS = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  link: 'a[href]',
  cite: 'span.cite[data-src]',
  citeParaphrase: 'span.cite[data-mode="paraphrase"]',
  citedBlockquote: 'blockquote[data-src]',
  xrefChapter: 'span.xref[data-xref="chapter"]',
  xrefPage: 'span.xref[data-xref="page"]',
  xrefFigure: 'span.xref[data-xref="figure"]',
  xrefTable: 'span.xref[data-xref="table"]',
  todoChecked: 'ul.todo input[checked]',
  msgLines: 'p.msg-in + p.msg-out',
  msgName: 'p.msg-name',
  msgMeta: 'p.msg-meta',
  figureCaption: 'figure figcaption',
  figureCredit: 'figure p.figure-credit',
  tableCaption: 'table caption',
  tableAlign: 'th[data-align="right"]',
};

function buildShowcaseHtml({ srcId, imgId, xrefChapterId, xrefPageId }) {
  const html = `
<h2>Überschrift H2</h2>
<p>Ein normaler Absatz mit <b>fett</b>, <i>kursiv</i>, <u>unterstrichen</u> und <b><i><u>allem zusammen</u></i></b>. Dazu ein <a href="https://de.wikipedia.org/wiki/Die_Verwandlung">Link nach aussen</a>, eine Quellenangabe <span class="cite" data-src="${srcId}" data-loc="5">(Kafka, 1915, S. 5)</span> und eine sinngemässe <span class="cite" data-src="${srcId}" data-loc="12–14" data-mode="paraphrase">(vgl. Kafka, 1915, S. 12–14)</span>.</p>
<h3>Überschrift H3</h3>
<p>Querverweise: siehe <span class="xref" data-xref="chapter" data-xref-id="${xrefChapterId}">Kapitel 2</span>, <span class="xref" data-xref="chapter" data-xref-id="${xrefChapterId}" data-xref-fmt="title">„Kapitel 2"</span>, Abschnitt <span class="xref" data-xref="page" data-xref-id="${xrefPageId}" data-xref-fmt="title">„Familie"</span>, <span class="xref" data-xref="figure" data-xref-id="${FIG_BID}">Abb. 1</span> und Tabelle <span class="xref" data-xref="table" data-xref-id="${TAB_BID}" data-xref-fmt="number">1</span>.</p>
<blockquote><p>Ein einfaches Blockzitat ohne Beleg. Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte …</p></blockquote>
<blockquote data-src="${srcId}"><p>Ein belegtes Blockzitat — die Quelle hängt am blockquote selbst.</p></blockquote>
<div class="poem"><p>Gedichtzeile eins,<br>Gedichtzeile zwei,</p><p>neue Strophe, Zeile drei.</p></div>
<ul><li>Aufzählung Punkt eins</li><li>Punkt zwei mit <b>fett</b></li><li>Punkt drei</li></ul>
<ol><li>Nummerierte Liste</li><li>Zweiter Eintrag</li></ol>
<ul class="todo"><li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Erledigte Aufgabe</span></li><li class="todo-item"><input type="checkbox"><span class="todo-text">Offene Aufgabe</span></li></ul>
<div class="msg-thread"><p class="msg-meta">Montag, 07:12</p><p class="msg-name">Grete</p><p class="msg-in">Gregor, bist du wach? Der Prokurist ist da.</p><p class="msg-out">Komme gleich. Ich hab den Zug verpasst.</p><p class="msg-in">Mutter weint.</p><p class="msg-out">Sag ihr, mir geht's gut.</p></div>
<hr>
<p>Nach der einfachen Trennlinie folgt ein Seitenumbruch:</p>
<hr class="pagebreak">
<p>… und danach eine Vakatseite:</p>
<hr class="blankpage">
<figure data-bid="${FIG_BID}"><img src="/content/page-image/${imgId}" alt="Farbverlauf von Blau nach Ocker mit der Aufschrift Testbild"><figcaption>Legende der Testabbildung mit <i>Auszeichnung</i></figcaption><p class="figure-credit">Foto: Devmode-Seed</p></figure>
<table data-bid="${TAB_BID}"><caption>Familie Samsa im Überblick</caption><thead><tr><th scope="col">Figur</th><th scope="col" data-align="center">Rolle</th><th scope="col" data-align="right">Alter</th></tr></thead><tbody><tr><td>Gregor</td><td data-align="center">Handlungsreisender</td><td data-align="right">28</td></tr><tr><td>Grete</td><td data-align="center">Schwester</td><td data-align="right">17</td></tr><tr><td>Vater</td><td data-align="center">Pensionär</td><td data-align="right">60</td></tr></tbody></table>
<pre class="mermaid">flowchart TD
  A[Gregor erwacht] --> B{Kann er aufstehen?}
  B -- nein --> C[Prokurist kommt]
  B -- ja --> D[Zug um fünf]
  C --> E[Familie entsetzt]</pre>
<p>Schlussabsatz.</p>`.replace(/\n(?=<)/g, '');
  return _withStableBids(html);
}

// Jeder Block ohne eigene ID bekommt eine aus seiner Position abgeleitete. So
// ist das gespeicherte HTML deterministisch und der Abgleich beim Start kann
// „unveraendert" erkennen, statt bei jedem Boot eine Revision zu schreiben.
function _withStableBids(html) {
  let i = 0;
  return html.replace(/<(p|h[1-6]|ul|ol|blockquote|pre|hr|figure|table|div)\b(?![^>]*data-bid=)/g, (m) => {
    const bid = crypto.createHash('sha256').update(`showcase:${i++}`).digest('hex').slice(0, 16);
    return `${m} data-bid="${bid}"`;
  });
}

function _shouldRun() {
  const flag = (k) => String(process.env[k] || '').toLowerCase();
  return flag('LOCAL_DEV_MODE') === 'true'
    && flag('LOCAL_DEV_SEED') !== 'false'
    && flag('LOCAL_DEV_SEED_SHOWCASE') !== 'false';
}

function _ensureSource(bookId) {
  const linked = sources.listSources(bookId, { includeArchived: true }).find(s => s.title === SOURCE_TITLE);
  if (linked) return linked.id;
  const created = sources.createSource(DEV_OWNER, {
    csl_type: 'book', title: SOURCE_TITLE, authors: [{ family: 'Kafka', given: 'Franz' }],
    publisher: 'Kurt Wolff', place: 'Leipzig', year: '1915',
  });
  linkSource(bookId, created.id, DEV_OWNER);
  return created.id;
}

async function _ensureImage(pageId, currentHtml) {
  const m = /\/content\/page-image\/(\d+)/.exec(currentHtml || '');
  if (m && getPageImage(Number(m[1]))?.page_id === pageId) return Number(m[1]);
  const sharp = require('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b5b7a"/><stop offset="1" stop-color="#c9a46b"/></linearGradient></defs>
    <rect width="800" height="400" fill="url(#g)"/>
    <text x="400" y="215" font-family="sans-serif" font-size="48" fill="#fff" text-anchor="middle">Testbild 800×400</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return insertPageImage({ pageId, mime: 'image/png', width: 800, height: 400, size: png.length, image: png });
}

async function syncFormattingShowcase() {
  if (!_shouldRun()) return null;
  const book = db.prepare('SELECT book_id FROM books WHERE name = ?').get(BOOK_NAME);
  if (!book) return null;
  const bookId = book.book_id;
  const ctx = { session: { user: { email: DEV_OWNER } } };

  const chapters = await store.listChapters(bookId, ctx);
  const pages = await store.listPages(bookId, ctx);
  const chapterId = chapters.find(c => c.name === CHAPTER_NAME)?.id ?? null;
  const xrefChapterId = chapters.find(c => c.name === XREF_CHAPTER_NAME)?.id;
  const xrefPageId = pages.find(p => p.name === XREF_PAGE_NAME)?.id;
  if (!xrefChapterId || !xrefPageId) {
    logger.info(`Formatierungs-Schaukasten uebersprungen: "${XREF_CHAPTER_NAME}"/"${XREF_PAGE_NAME}" fehlen im Testbuch.`);
    return null;
  }

  let meta = pages.find(p => p.name === PAGE_NAME);
  let created = false;
  if (!meta) {
    meta = await store.createPage({ book_id: bookId, chapter_id: chapterId, name: PAGE_NAME, html: '<p></p>' }, ctx);
    created = true;
  }
  const current = created ? null : await store.loadPage(meta.id, ctx);
  const imgId = await _ensureImage(meta.id, current?.html);
  const srcId = _ensureSource(bookId);

  const html = buildShowcaseHtml({ srcId, imgId, xrefChapterId, xrefPageId });
  if (!created && current?.html === ensureBlockIds(cleanPageHtml(html))) return { pageId: meta.id, changed: false };

  await store.savePage(meta.id, { html }, ctx);
  logger.info(`Formatierungs-Schaukasten im Testbuch ${created ? 'angelegt' : 'aktualisiert'} (page=${meta.id}).`);
  return { pageId: meta.id, changed: true };
}

module.exports = {
  syncFormattingShowcase, buildShowcaseHtml,
  SHOWCASE_SELECTORS, SHOWCASE_EXEMPT, SHOWCASE_INLINE_SELECTORS,
};

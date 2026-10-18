// Volltextsuche ohne Verbindung — über die Abschnitte, die der Service Worker
// auf dem Gerät hält (angeheftetes bzw. zuletzt geöffnetes Buch,
// public/sw-offline.js, plus was der Content-Cache vom Lesen kennt).
//
// Die Serversuche (routes/search.js, FTS5) ist offline nicht erreichbar und
// wird bewusst nie gecacht. Statt „Suche fehlgeschlagen" durchsucht die
// Suchkarte dann diesen lokalen Bestand: Abschnitte (Titel + Text) und Kapitel
// (Name) des aktuellen Buchs. Kein Ranking-Ersatz für FTS5 — alle Suchwörter
// müssen vorkommen (UND), Gross-/Kleinschreibung und Akzente zählen nicht.
//
// LOKALER STAND: durchsucht wird, was der User auf diesem Gerät sieht — ein
// ungesendeter Entwurf (editor/draft-storage.js) statt des gecachten Server-
// Texts, offline angelegte Abschnitte und neue Namen aus der Struktur-
// Warteschlange (repo/structure-queue.js). Andere Arten (Figuren, Orte, Ideen
// …) kennt die lokale Suche nicht; sie meldet sie als `unsupportedKinds`, die
// Karte sagt es an, statt still nichts zu finden.
//
// Treffer haben dieselbe Form wie die der Serversuche
// ({ kind, entity_id, nav_id, book_id, title, chapter, snippet, rank }), damit
// Liste und Sprungziel unverändert bleiben. `snippet` geht in ein `x-html`:
// er wird darum hier escaped, erst danach kommen die <mark>-Tags dazu.
import { escHtml } from '../utils/escape.js';
import { readDraft } from '../editor/draft-storage.js';
import { pendingStructureOps } from '../repo/structure-queue.js';

export const OFFLINE_KINDS = ['page', 'chapter'];

// Benannte Entities, die im gespeicherten Abschnitts-HTML vorkommen (der
// Server-Cleaner lässt Umlaute meist roh, Importe und Alt-Bestand nicht).
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', ccedil: 'ç',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', bdquo: '„', ldquo: '“', rdquo: '”',
  sbquo: '‚', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', shy: '',
};

function _decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : m; } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

const SNIPPET_RADIUS = 60;

// Zeichenweise faltet: Länge bleibt gleich, damit Fundstellen im gefalteten
// Text auch im Original stehen (für das Snippet).
export function foldText(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === 1 ? f : (ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch);
  }
  return out;
}

// Gleiche Normalisierung wie die Seiten-Stats (routes/sync.js#htmlToText):
// Tags zu Leerzeichen, Whitespace zusammengezogen. Dazu die häufigen Entities.
export function htmlToSearchText(html) {
  return _decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTerms(q) {
  return [...new Set(foldText(q).split(/\s+/).filter((t) => t.length >= 2))];
}

function _allPositions(hay, term) {
  const out = [];
  for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + term.length)) out.push(i);
  return out;
}

// Ausschnitt um die erste Fundstelle, escaped, Suchwörter markiert.
export function buildSnippet(text, terms) {
  const folded = foldText(text);
  let first = -1;
  for (const t of terms) {
    const i = folded.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0) return '';
  const start = Math.max(0, first - SNIPPET_RADIUS);
  const end = Math.min(text.length, first + SNIPPET_RADIUS * 2);
  const piece = text.slice(start, end);
  const fp = folded.slice(start, end);
  // Markierte Bereiche im Ausschnitt, überlappende zusammengelegt.
  const ranges = [];
  for (const t of terms) for (const i of _allPositions(fp, t)) ranges.push([i, i + t.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let html = '';
  let pos = 0;
  for (const [a, b] of merged) {
    html += escHtml(piece.slice(pos, a)) + '<mark>' + escHtml(piece.slice(a, b)) + '</mark>';
    pos = b;
  }
  html += escHtml(piece.slice(pos));
  return (start > 0 ? '…' : '') + html + (end < text.length ? '…' : '');
}

// Kern, rein: `pages` = [{ id, name, chapter, text }], `chapters` = [{ id, name }].
export function searchOffline({ pages = [], chapters = [], bookId = null }, query, { kinds = ['page', 'chapter'], limit = 50 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits = [];
  if (kinds.includes('chapter')) {
    for (const c of chapters) {
      const name = foldText(c.name);
      if (!terms.every((t) => name.includes(t))) continue;
      hits.push({
        kind: 'chapter', entity_id: c.id, nav_id: c.id, book_id: bookId,
        title: c.name, snippet: '', rank: 100,
      });
    }
  }
  if (kinds.includes('page')) {
    for (const p of pages) {
      const title = foldText(p.name);
      const body = foldText(p.text);
      if (!terms.every((t) => title.includes(t) || body.includes(t))) continue;
      let rank = 0;
      for (const t of terms) rank += _allPositions(body, t).length + (title.includes(t) ? 10 : 0);
      hits.push({
        kind: 'page', entity_id: p.id, nav_id: p.id, book_id: bookId,
        title: p.name, chapter: p.chapter || null,
        snippet: buildSnippet(p.text, terms), rank,
      });
    }
  }
  hits.sort((a, b) => b.rank - a.rank);
  return hits.slice(0, limit);
}

// Abschnitte + Kapitel aus dem Baum (gleiche Form wie sw-offline.js#pagesOfTree).
export function flattenTree(tree) {
  const pages = [];
  const chapters = [];
  const walk = (list) => {
    for (const c of list || []) {
      chapters.push({ id: c.id, name: c.name });
      for (const p of c.pages || []) pages.push({ id: p.id, name: p.name, chapter: c.name });
      walk(c.subchapters);
    }
  };
  for (const p of tree?.topPages || []) pages.push({ id: p.id, name: p.name, chapter: null });
  walk(tree?.chapters);
  return { pages: pages.filter((p) => p.id != null), chapters };
}

async function _cachedJson(path) {
  if (typeof caches === 'undefined') return null;
  try {
    const res = await caches.match(new URL(path, location.origin).href);
    return res ? await res.json() : null;
  } catch { return null; }
}

// Browser: Buch aus dem Cache lesen und durchsuchen. `covered`/`total` sagen,
// wie viele Abschnitte des Baums lokal lagen — die Karte meldet Lücken.
// Vorgemerkte Struktur über den Baum legen: neue Namen, offline angelegte
// Abschnitte (mit ihrem Text aus der Operation). Rein.
export function overlayLocalStructure({ pages, chapters }, ops, bookId) {
  const outPages = pages.map((p) => ({ ...p }));
  const outChapters = chapters.map((c) => ({ ...c }));
  const created = [];
  for (const op of ops || []) {
    if (op.bookId != null && bookId != null && String(op.bookId) !== String(bookId)) continue;
    if (op.op === 'rename') {
      const list = op.kind === 'page' ? outPages : outChapters;
      for (const x of list) if (Number(x.id) === Number(op.id)) x.name = op.name;
    } else if (op.op === 'createPage' && op.page) {
      const ch = outChapters.find((c) => Number(c.id) === Number(op.body?.chapter_id));
      created.push({ id: op.tempId, name: op.page.name, chapter: ch?.name || null, html: op.page.html || '' });
    }
  }
  return { pages: outPages, chapters: outChapters, created };
}

// Browser: Buch aus dem Cache lesen und durchsuchen — mit dem lokalen Stand
// darüber (Entwürfe, vorgemerkte Struktur). `covered`/`total` sagen, wie viele
// Abschnitte des Baums lokal lagen — die Karte meldet Lücken.
export async function searchOfflineBook(bookId, query, opts = {}) {
  const unsupportedKinds = (opts.kinds || OFFLINE_KINDS).filter((k) => !OFFLINE_KINDS.includes(k));
  const tree = bookId != null ? await _cachedJson(`/content/books/${bookId}/tree`) : null;
  if (!tree) return { hits: [], covered: 0, total: 0, noTree: true, unsupportedKinds };
  let ops = [];
  try { ops = pendingStructureOps(); } catch { /* ohne Warteschlange */ }
  const { pages, chapters, created } = overlayLocalStructure(flattenTree(tree), ops, bookId);
  const loaded = [];
  for (const p of pages) {
    const draft = readDraft(p.id);
    if (draft?.html) { loaded.push({ ...p, text: htmlToSearchText(draft.html) }); continue; }
    const page = await _cachedJson(`/content/pages/${p.id}`);
    if (!page) continue;
    loaded.push({ ...p, name: p.name || page.name, text: htmlToSearchText(page.html ?? page.body_html ?? '') });
  }
  for (const c of created) loaded.push({ id: c.id, name: c.name, chapter: c.chapter, text: htmlToSearchText(readDraft(c.id)?.html || c.html) });
  const kinds = (opts.kinds || OFFLINE_KINDS).filter((k) => OFFLINE_KINDS.includes(k));
  const hits = searchOffline({ pages: loaded, chapters, bookId: Number(bookId) }, query, { ...opts, kinds });
  return { hits, covered: loaded.length, total: pages.length + created.length, noTree: false, unsupportedKinds };
}

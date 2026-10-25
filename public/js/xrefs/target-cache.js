// Verweis-ZIELE eines Buchs im Browser — geladen, gecacht und zu
// Vorschau-Nummern verrechnet.
//
// ZWEI KONSUMENTEN, EIN CACHE: der Ziel-Picker im Notebook-Editor
// (editor/notebook/toolbar/xref.js) und die Legenden-Nummern der Leseansichten
// (caption-preview.js) brauchen exakt dieselbe Antwort. Zwei Caches nebeneinander
// waeren zwei Staende desselben Buchs — der Picker zeigte „Abb. 3.2", die
// Leseansicht daneben „Abb. 3.1", und niemand saehe, welcher recht hat.
//
// DIE NUMMERN HIER SIND EINE VORSCHAU. Sie folgen der nested-arabischen Vorgabe
// (1, 1.1, „Abb. 2.1"). Was im fertigen Dokument steht, entscheidet der
// Ausgabeweg — lib/xref-render.js setzt es beim Export neu, mit den Kapitel-
// Labels des Profils. Das ist kein Fehler, sondern der Kern des Features.

import { defaultChapterLabels, anchorNumbers } from './xref-number.js';

// Ziele je Buch nur einmal holen. Sie aendern sich beim Umbauen des Buchs oder
// beim Einfuegen einer Abbildung; beides dispatcht `xrefs:changed`.
const _targetCache = new Map();
// Laufende Anfragen je Buch: gleichzeitige Aufrufer (Leseansicht rendert,
// Picker oeffnet) teilen sich einen Fetch. Eine Invalidierung waehrend des
// Fetches verwirft ihn als Cache-Kandidaten — seine Antwort koennte den Stand
// vor der Aenderung tragen.
const _inflight = new Map();

export function invalidateXrefTargetCache(bookId = null) {
  if (bookId == null) { _targetCache.clear(); _inflight.clear(); }
  else { _targetCache.delete(String(bookId)); _inflight.delete(String(bookId)); }
}

export async function loadXrefTargets(bookId) {
  const key = String(bookId);
  if (_targetCache.has(key)) return _targetCache.get(key);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = _fetchXrefTargets(key)
    .then((out) => { if (_inflight.get(key) === p) _targetCache.set(key, out); return out; })
    .finally(() => { if (_inflight.get(key) === p) _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

async function _fetchXrefTargets(key) {
  const res = await fetch(`/xrefs/targets?book_id=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    chapters: Array.isArray(data?.chapters) ? data.chapters : [],
    figures: Array.isArray(data?.figures) ? data.figures : [],
    tables: Array.isArray(data?.tables) ? data.tables : [],
    // Schalter und Buchsprache kommen aus denselben `book_settings`, die auch
    // der Renderer liest. Fehlen sie (aeltere Antwort), wird nicht nummeriert —
    // lieber keine Nummer als eine erfundene.
    figureNumbering: !!data?.figureNumbering,
    tableNumbering: !!data?.tableNumbering,
    lang: data?.lang === 'en' ? 'en' : 'de',
  };
}

/** Vorschau-Nummern ueber beide Achsen — dieselbe pure Logik, die auch der
 *  Renderer benutzt, nur ohne Profil-Labels. */
export function previewNumbers({ chapters, figures, tables }) {
  // Tiefe aus der Elternkette (max 3 Ebenen, siehe docs/chapter-hierarchy.md).
  const byId = new Map((chapters || []).map(c => [String(c.target), c]));
  const shaped = (chapters || []).map((c) => {
    let depth = 1;
    let cur = c;
    const seen = new Set();
    while (cur && cur.parentId != null && !seen.has(cur.target) && depth < 3) {
      seen.add(cur.target);
      cur = byId.get(String(cur.parentId));
      if (!cur) break;
      depth++;
    }
    return { chapterId: c.target, depth, title: c.title };
  });
  const chapterLabels = defaultChapterLabels(shaped);
  // Zwei Aufrufe, zwei Zaehler: Abbildungen und Tabellen zaehlen getrennt (siehe
  // xref-number.js). Ein gemeinsamer Aufruf zeigte Nummern, die der Renderer
  // nachher nicht setzt.
  const toAnchors = (list) => (list || []).map(a => ({ bid: a.target, chapterId: a.chapterId }));
  const figNums = anchorNumbers(toAnchors(figures), chapterLabels);
  const tblNums = anchorNumbers(toAnchors(tables), chapterLabels);
  return {
    chapterLabels, figNums, tblNums,
    depthById: new Map(shaped.map(s => [String(s.chapterId), s.depth])),
  };
}

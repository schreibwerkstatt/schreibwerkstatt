'use strict';
// Kapitel-Gruppen → Chunks (pure, ohne DB-/KI-Abhängigkeit, Facade: ./loader.js).
//
// Grundeinheit ist der Abschnitt (page). Ein Abschnitt, der allein grösser ist als
// das Chunk-Limit, wird in TEILE zerlegt — an Absatzgrenzen, sonst an Satzgrenzen,
// notfalls an einem Leerzeichen. Ein Teil ist ein normaler Seiten-Eintrag mit
// derselben Identität (`id`, `title`, `updated_at`, Kapitel-Felder) und dem Feld
// `part = { nr, von, start, end }` (Zeichen-Offsets im Volltext des Abschnitts).
// Die Prompt-Überschrift bleibt `### ${title}` OHNE Teil-Markierung: die KI gibt den
// Abschnittstitel als Bezug zurück (Szene.seite, locateStelle, page_id-Mapping) und
// muss dafür exakt den echten Titel sehen.
//
// Invarianten:
// - Kein Abschnitt über dem Limit → Ergebnis byte-identisch zum reinen Seiten-Split
//   (Chunk-Keys, Seiten-Objekte, Reihenfolge): Delta-Caches und der geteilte
//   Prompt-Cache-Präfix der Komplettanalyse bleiben stabil.
// - Pro Chunk höchstens ein Eintrag je Abschnitt: vor Teil 2..n wird der laufende
//   Chunk geschlossen.
// - Cache-Signaturen über `chunk.pages` hängen `pageSigSuffix(p)` an — sonst trügen
//   zwei Teile desselben Abschnitts dieselbe Signatur, und ein geänderter Split
//   (anderes Limit) lieferte einen Cache-HIT mit fremdem Textausschnitt.

const PARA_RE = /\n[ \t]*\n\s*/g;
// Satzende: Satzzeichen, optional schliessende Anführung/Klammer, dann Whitespace.
const SENT_RE = /[.!?…]["'»«“”‘’)\]]*\s+(?=\S)/g;
const SPACE_RE = /\s+(?=\S)/g;

/** Schnittpositionen (Index NACH dem trennenden Whitespace) für ein Muster. */
function _boundaries(text, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m.index + m[0].length);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Bester Schnitt in [lo, hi]: nächster zu `target`, Absatz > Satz > Leerzeichen. */
function _pickCut(levels, lo, hi, target) {
  for (const cuts of levels) {
    let best = -1, bestDist = Infinity;
    for (const c of cuts) {
      if (c < lo || c > hi) continue;
      const d = Math.abs(c - target);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function _levels(text) {
  return [_boundaries(text, PARA_RE), _boundaries(text, SENT_RE), _boundaries(text, SPACE_RE)];
}

/**
 * Zerlegt einen Text in Bereiche ≤ limit, möglichst gleich gross, an Absatz-/Satz-
 * grenzen. Liefert `[{ start, end }]` (end exklusiv, Whitespace am Rand ausgespart).
 */
function splitTextRanges(text, limit) {
  const len = text.length;
  if (len <= limit) return [{ start: 0, end: len }];
  const levels = _levels(text);
  const ranges = [];
  let pos = 0;
  while (len - pos > limit) {
    const remaining = len - pos;
    const partsLeft = Math.ceil(remaining / limit);
    const target = pos + Math.ceil(remaining / partsLeft);
    const hi = pos + limit;
    // Ein Schnitt weit vor dem Ziel erzeugt Zwergteile → untere Fenstergrenze bei der
    // halben Zielgrösse; findet sich dort nichts, das ganze Fenster.
    let cut = _pickCut(levels, pos + Math.floor((target - pos) / 2), hi, target);
    if (cut <= pos) cut = _pickCut(levels, pos + 1, hi, target);
    if (cut <= pos) cut = hi; // kein Whitespace im Fenster: harter Schnitt
    let end = cut;
    while (end > pos && /\s/.test(text[end - 1])) end--;
    ranges.push({ start: pos, end });
    pos = cut;
    while (pos < len && /\s/.test(text[pos])) pos++;
  }
  if (pos < len) ranges.push({ start: pos, end: len });
  return ranges;
}

/** Teil-Einträge eines Abschnitts (Identität bleibt, `part` trägt die Offsets). */
function _makeParts(page, ranges) {
  const base = page.part ? page.part.start : 0;
  return ranges.map((r, i) => ({
    ...page,
    text: page.text.slice(r.start, r.end),
    part: { nr: i + 1, von: ranges.length, start: base + r.start, end: base + r.end },
  }));
}

/** Zerlegt einen Abschnitt in Teile ≤ limit. Passt er, kommt `[page]` unverändert zurück. */
function splitPageIntoParts(page, limit) {
  if (page.text.length <= limit) return [page];
  return _makeParts(page, splitTextRanges(page.text, limit));
}

/**
 * Halbiert die Seitenliste eines Chunks (Truncation-Fallback der Komplett-Extraktion).
 * ≥2 Einträge: seitenweise wie bisher. Genau ein Eintrag: sein Text wird an der
 * Absatz-/Satzgrenze nächst der Mitte geteilt (Fenster 25–75 %). `null`, wenn sich
 * nichts teilen lässt (leer, oder kein Whitespace im Fenster).
 */
function halveChunkPages(pages) {
  if (!pages || pages.length === 0) return null;
  if (pages.length >= 2) {
    const mid = Math.ceil(pages.length / 2);
    return [pages.slice(0, mid), pages.slice(mid)];
  }
  const page = pages[0];
  const text = page.text || '';
  const len = text.length;
  if (len < 2) return null;
  const cut = _pickCut(_levels(text), Math.floor(len * 0.25), Math.ceil(len * 0.75), Math.floor(len / 2));
  if (cut <= 0 || cut >= len) return null;
  let end = cut;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === 0) return null;
  const parts = _makeParts(page, [{ start: 0, end }, { start: cut, end: len }]);
  return [[parts[0]], [parts[1]]];
}

/** Signatur-Anhang eines Seiten-Eintrags: '' für ganze Abschnitte, `#start-end` für Teile. */
function pageSigSuffix(p) {
  return p && p.part ? `#${p.part.start}-${p.part.end}` : '';
}

/**
 * Teilt Kapitel-Gruppen in kleinere Chunks auf, wenn sie perChunkLimit überschreiten.
 * Nicht aufzuteilende Kapitel behalten ihren Original-Key (bestehende Cache-Einträge bleiben gültig).
 * Sub-Chunks erhalten den Key "${chapterKey}__sub${idx}". Ein einzelner Abschnitt über dem
 * Limit wird vorher in Teile zerlegt (siehe Modulkopf).
 * Gibt { chunkOrder, chunks } zurück – gleiche Struktur wie groupByChapter, drop-in verwendbar.
 */
function splitGroupsIntoChunks(groups, groupOrder, perChunkLimit) {
  const chunkOrder = [], chunks = new Map();
  for (const key of groupOrder) {
    const group = groups.get(key);
    const totalChars = group.pages.reduce((s, p) => s + p.text.length, 0);
    if (totalChars <= perChunkLimit) {
      chunkOrder.push(key);
      chunks.set(key, group);
      continue;
    }
    let currentPages = [], currentChars = 0, subIdx = 0;
    const flush = () => {
      chunkOrder.push(`${key}__sub${subIdx}`);
      chunks.set(`${key}__sub${subIdx}`, { name: group.name, pages: currentPages });
      currentPages = []; currentChars = 0; subIdx++;
    };
    for (const whole of group.pages) {
      for (const page of splitPageIntoParts(whole, perChunkLimit)) {
        const laterPart = page.part && page.part.nr > 1;
        if ((laterPart || currentChars + page.text.length > perChunkLimit) && currentPages.length > 0) flush();
        currentPages.push(page);
        currentChars += page.text.length;
      }
    }
    if (currentPages.length > 0) flush();
  }
  return { chunkOrder, chunks };
}

module.exports = { splitGroupsIntoChunks, splitPageIntoParts, splitTextRanges, halveChunkPages, pageSigSuffix };

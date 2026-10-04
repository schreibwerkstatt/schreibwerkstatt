'use strict';
// Pure Helfer für die semantische Suche: Chunking, Vektor-(De)Serialisierung,
// Cosinus-Ähnlichkeit, Content-Hash. Ohne DB-/Netz-Abhängigkeit → unit-testbar
// (tests/unit/embed-chunk.test.mjs). Konsumiert von db/semantic-chunks.js,
// routes/jobs/embed-index.js und routes/search.js.

const crypto = require('crypto');

// Chunk-Grösse in Zeichen. ~1500 Zeichen ≈ 500 Tokens (Deutsch). bge-m3 hält 8k
// Kontext, aber kleinere Chunks lokalisieren Treffer präziser („diese Passage"
// statt „diese halbe Seite"). Overlap verhindert, dass ein an der Grenze zer-
// schnittener Gedanke in keinem Chunk mehr ganz vorkommt.
const CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

// Abkürzungen, nach deren Punkt KEIN Satz endet („Dr. Meier", „vgl. Kap. 3").
// Vergleich in Kleinschreibung, ohne den Punkt. Einbuchstabige („z. B.", „d. h.")
// deckt die Initial-Regel in _endsSentence ab.
const ABBREVIATIONS = new Set([
  'vgl', 'bzw', 'usw', 'etc', 'ca', 'dr', 'prof',
  'nr', 'st', 'str', 'hr', 'fr', 'frl', 'ggf', 'evtl', 'inkl', 'exkl', 'bspw', 'sog', 'jh',
  'jhd', 'mio', 'mrd', 'abs', 'art', 'bd', 'kap', 'ff', 'hrsg', 'aufl', 'mr', 'mrs', 'ms',
  'vs', 'no', 'pp', 'ed', 'al', 'resp', 'max', 'min', 'gem', 'lt', 'zit', 'anm',
]);
// Schliessende Zeichen, die hinter dem Satzzeichen noch zum Satz gehören.
const CLOSERS = '"\'»«“”‘’›‹)]';

// Monatsnamen: „am 3. März" ist eine Ordinalzahl, „Nummer 17. Dann" ein Satzende.
const MONTHS = /^(jan(uar)?|feb(ruar)?|märz|mär|apr(il)?|mai|jun[ie]?|jul[iy]?|aug(ust)?|sep(t(ember)?)?|okt(ober)?|nov(ember)?|dez(ember)?)\b/i;

// Endet an Position i (Index des Zeichens VOR dem Leerzeichen bei i+1) ein Satz?
// Satzzeichen . ! ? … plus optionale schliessende Anführungszeichen/Klammern.
// Kein Satzende: Punkt nach Abkürzung, nach einem Einzelbuchstaben (Initial
// „Anna K. Berger") oder nach einer Zahl vor einem Monatsnamen („am 3. März").
function _endsSentence(text, i) {
  let j = i;
  while (j >= 0 && CLOSERS.includes(text[j])) j--;
  const ch = text[j];
  if (ch === '!' || ch === '?' || ch === '…') return true;
  if (ch !== '.') return false;
  if (text[j - 1] === '.' ) return true; // „..." als Auslassung
  let k = j - 1;
  while (k >= 0 && /[\p{L}\p{N}]/u.test(text[k])) k--;
  const token = text.slice(k + 1, j);
  if (!token) return true;
  if (/^\p{N}+$/u.test(token)) return !MONTHS.test(text.slice(i + 1).trimStart());
  if (token.length === 1) return false;
  return !ABBREVIATIONS.has(token.toLowerCase());
}

// Text → einzeilige Fassung + Positionen, an denen ein Absatz beginnt. Absatz =
// Leerzeile (oder mehr); ein einzelner Umbruch ist ein harter Zeilenumbruch im
// Fluss (PDF-Volltext) und zählt als Leerzeichen.
function _normalize(text) {
  const paras = String(text == null ? '' : text)
    .split(/\n[ \t\r\f\v]*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const paraStarts = [];
  let clean = '';
  for (const p of paras) {
    if (clean) clean += ' ';
    paraStarts.push(clean.length);
    clean += p;
  }
  return { clean, paraStarts };
}

// Zerlegt Text in überlappende Chunks (je <= maxChars, gespeichert einzeilig).
// Schnitt-Rangfolge im hinteren Teil des Fensters: Absatzgrenze > Satzende >
// Wortgrenze > harter Schnitt. Der Folge-Chunk beginnt an einem Satzanfang
// innerhalb der Überlappung (ganzer Satz als Kontext), sonst an einer
// Wortgrenze — nie mitten im Wort. Kurzer Text (<= maxChars) → genau ein Chunk.
// Leerer/whitespace-Text → [].
function chunkText(text, { maxChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const { clean, paraStarts } = _normalize(text);
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // Grenzen vorab: Satzanfänge (Position nach dem Leerzeichen) und Absatzanfänge.
  const paraSet = new Set(paraStarts);
  const sentenceStarts = [];
  for (let i = 1; i < clean.length - 1; i++) {
    if (clean[i] !== ' ') continue;
    // Kleinbuchstabe danach: kein Satzanfang (»Komm.« dann ging er).
    if (paraSet.has(i + 1) || (_endsSentence(clean, i - 1) && !/\p{Ll}/u.test(clean[i + 1]))) sentenceStarts.push(i + 1);
  }
  const lastIn = (arr, lo, hi) => { // grösstes x mit lo <= x <= hi
    let r = -1;
    for (const x of arr) { if (x > hi) break; if (x >= lo) r = x; }
    return r;
  };
  const firstIn = (arr, lo, hi) => {
    for (const x of arr) { if (x > hi) return -1; if (x >= lo) return x; }
    return -1;
  };

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      // end = Index des Anfangs des nächsten Chunks-Inhalts (exklusiv): eine
      // Grenze b (Satz-/Absatzanfang) schneidet bei b - 1 (das Leerzeichen).
      const para = lastIn(paraStarts, start + Math.floor(maxChars * 0.5), end);
      const sent = lastIn(sentenceStarts, start + Math.floor(maxChars * 0.6), end);
      const space = clean.lastIndexOf(' ', end);
      if (para > start) end = para - 1;
      else if (sent > start) end = sent - 1;
      else if (space > start + Math.floor(maxChars * 0.75)) end = space;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;

    // Folge-Start: frühester Satzanfang in [end - 1.5·overlap, end - 20], damit
    // die Überlappung aus ganzen Sätzen besteht; sonst die Wortgrenze nach
    // end - overlap.
    const lo = Math.max(start + 1, end - Math.floor(overlap * 1.5));
    let next = firstIn(sentenceStarts, lo, end - 20);
    if (next < 0) {
      const target = Math.max(start + 1, end - overlap);
      const sp = clean.indexOf(' ', target);
      next = sp >= 0 && sp < end ? sp + 1 : target;
    }
    start = Math.max(next, start + 1);
  }
  return chunks;
}

// Float32Array ↔ Buffer (Little-Endian, roh). Kompakt (4 Byte/Dimension) und
// direkt in eine SQLite-BLOB-Spalte schreibbar.
function vectorToBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToVector(buf) {
  // Kopie über Uint8Array, weil der Buffer nicht 4-Byte-aligned sein muss.
  const copy = Uint8Array.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

// Cosinus-Ähnlichkeit zweier gleich langer Vektoren, [-1, 1]. Ungleiche Länge
// (z.B. Modellwechsel) → -Infinity, damit solche Chunks nie als Treffer ranken.
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -Infinity;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Stabiler Hash über den Chunk-Text — Basis des Delta-Caches (unveränderter
// Chunk → kein erneuter Embedding-Call).
function contentHash(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16);
}

module.exports = {
  _endsSentence,
  CHUNK_CHARS, CHUNK_OVERLAP,
  chunkText, vectorToBlob, blobToVector, cosineSim, contentHash,
};

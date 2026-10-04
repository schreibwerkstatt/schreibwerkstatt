// Satz-Segmentierung + Chunking fuer das Vorlesen (TTS / Proof-Listening).
// SSoT, geteilt zwischen dem Notebook-Proof-Listening (Alpine-Root,
// editor/notebook/tts-proof.js) und dem Share-Reader-Vorlese-Dock (Vanilla,
// share-reader/tts.js). Keine Browser-Globals beim Import (Intl.Segmenter mit
// Regex-Fallback); die DOM-Helfer arbeiten nur auf uebergebenen Knoten — mit
// linkedom ohne Browser testbar.
//
// Warum die zwei Chunk-Korrektive: sehr kurze Eingaben lassen XTTS-v2 am
// Satzende einen erfundenen Restlaut anhaengen (Kurz-Input-Halluzination) →
// Kurz-Satz-Buendelung. Sehr lange Saetze ergaeben einen Request mit
// zweistelliger Synthese-Latenz (naehert sich dem 20s-Server-Timeout) + einen
// monoton heruntergelesenen Audio-Block → Lang-Satz-Splitting an Klausel-Grenzen.

// Mindest-Zeichenzahl pro Synthese-Chunk (Kurz-Satz-Buendelung).
export const TTS_MIN_CHUNK_CHARS = 60;
// Hoechst-Zeichenzahl pro Synthese-Chunk (Lang-Satz-Splitting).
export const TTS_MAX_CHUNK_CHARS = 220;

// Satzgrenzen via Intl.Segmenter (handhabt Abkuerzungen wie „z. B." korrekt),
// Fallback Regex split nach .!?. Liefert [start,end]-Offset-Paare in `text`.
export function computeTtsSentences(text, locale = 'de') {
  if (!text || !text.trim()) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const out = [];
      for (const s of seg.segment(text)) {
        if (s.segment.trim()) out.push([s.index, s.index + s.segment.length]);
      }
      return out;
    } catch { /* fallthrough */ }
  }
  const out = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Kurze Satz-Ranges (in `text`) zu Chunks >= minLen buendeln. Ein anwachsender
// Chunk schluckt Folgesaetze, bis seine getrimmte Laenge die Schwelle erreicht;
// ein zu kurzer Rest am Ende wird in den Vorgaenger gezogen. `maxLen` deckelt das
// Anwachsen, damit die Buendelung die Split-Stuecke nicht wieder ueber die Grenze
// zusammenzieht (Default Infinity = kein Deckel).
export function coalesceTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = Infinity) {
  if (!Array.isArray(ranges) || ranges.length <= 1) return ranges || [];
  const len = ([s, e]) => text.slice(s, e).trim().length;
  const fits = (s, e) => text.slice(s, e).trim().length <= maxLen;
  const merged = [];
  let cur = null;
  for (const [s, e] of ranges) {
    if (!cur) { cur = [s, e]; continue; }
    if (len(cur) < minLen && fits(cur[0], e)) { cur[1] = e; } // zu kurz + passt -> anhaengen
    else { merged.push(cur); cur = [s, e]; }                  // lang genug / wuerde sprengen -> abschliessen
  }
  if (cur) {
    const prev = merged[merged.length - 1];
    if (len(cur) < minLen && prev && fits(prev[0], cur[1])) prev[1] = cur[1];
    else merged.push(cur);
  }
  return merged;
}

// Eine zu lange Satz-Range an Klausel-/Wortgrenzen in Teilstuecke <= maxLen
// zerlegen. Bevorzugt nach dem LETZTEN Klausel-Zeichen im Fenster (; : , oder
// freistehender Gedankenstrich - – —), sonst am letzten Leerzeichen, im Notfall
// hart bei maxLen. Intra-Wort-Bindestriche („Midlife-Krise") bleiben unangetastet.
export function splitLongRange([s, e], text, maxLen = TTS_MAX_CHUNK_CHARS) {
  const out = [];
  let start = s;
  while (e - start > maxLen) {
    const win = text.slice(start, start + maxLen);
    let cut = -1;
    const clause = /[;:,](?=\s|$)|\s[-–—]\s/g;
    let m;
    while ((m = clause.exec(win)) !== null) cut = m.index + m[0].length;
    if (cut <= 0) {
      const sp = win.lastIndexOf(' ');
      cut = sp > 0 ? sp + 1 : maxLen; // kein Trennpunkt -> harter Schnitt
    }
    out.push([start, start + cut]);
    start += cut;
  }
  if (start < e) out.push([start, e]);
  return out;
}

// Satz-Ranges eines Blocks in synthese-taugliche Chunks bringen: erst zu lange
// Saetze splitten, dann zu kurze buendeln (mit maxLen-Deckel).
export function chunkTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = TTS_MAX_CHUNK_CHARS) {
  if (!Array.isArray(ranges) || !ranges.length) return ranges || [];
  const split = [];
  for (const r of ranges) {
    if (text.slice(r[0], r[1]).trim().length > maxLen) split.push(...splitLongRange(r, text, maxLen));
    else split.push(r);
  }
  return coalesceTtsRanges(split, text, minLen, maxLen);
}

// Text fuer die Sprachausgabe aufbereiten — rein fuer den gesendeten Text;
// angezeigter Text und Highlight-Offsets bleiben unberuehrt (die Konsumenten
// rechnen mit `seg.startOff/endOff` im Block, nie mit diesem Ergebnis).
//   - Guillemets (« » ‹ ›) spricht XTTS als Lautfolge aus → gerade Anfuehrung.
//   - Zeilenumbruch (aus <br>/Blockgrenze, siehe ttsUnits) ohne Satzzeichen
//     davor → Komma: Gedicht- und Listenzeilen bekommen eine Atempause, statt
//     nahtlos ineinanderzulaufen.
//   - freistehender Gedankenstrich und Auslassungspunkte → Komma bzw. am Ende
//     Punkt: manche Engines lesen „Strich" / „Punkt Punkt Punkt" vor.
//   - Auszeichnungsreste (* _ # ~, z. B. Szenentrenner „* * *") fallen weg.
export function normalizeForSpeech(text) {
  return String(text ?? '')
    .replace(/[«»]/g, '"').replace(/[‹›]/g, "'")
    .replace(/(\S)[ \t]*\n\s*(?=\S)/gu, (_m, c) => (/[.,;:!?…"')\]–—-]/u.test(c) ? `${c} ` : `${c}, `))
    .replace(/\s+[–—-]\s+/gu, ', ')
    .replace(/(\p{L})—(?=\p{L})/gu, '$1, ')
    .replace(/(?:…|\.{3})(?=["'\s]*$)/u, '.')
    .replace(/\s*(?:…|\.{3})\s*/gu, ', ')
    .replace(/[*_#~]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Sprech-Text eines Blocks (Beleg-Chips ausgelassen) ──────────────────────
// Quellennachweise sollen nicht mitgelesen werden: „(Kafka, 1915, S. 44)" mitten
// im Satz zerreisst den Hoerfluss und ist genau die Information, die beim
// Vorlesen nichts beitraegt.
//
// Text UND Highlight muessen dabei in EINEM Offsetraum leben — beide Konsumenten
// bauen ihre Satz-Range aus Zeichen-Offsets in denselben Textknoten. Darum
// liefern `ttsUnits` die Einheitenliste, aus der alles arbeitet: `ttsBlockText`
// verkettet sie zum Sprech-Text, `ttsBuildRange`/`ttsOffsetAt` laufen ueber
// dieselbe Liste statt ueber einen eigenen TreeWalker. Wuerde nur der Sprechtext
// gefiltert, driftete das Highlight um die Chip-Laenge.
//
// Der Selektor ist eine bewusste KOPIE von CITE_SEL (public/js/sources/
// cite-html.js): der Share-Reader importiert dieses Modul und bleibt ein
// eigenstaendiger, schlanker Modulgraph — es darf deshalb nichts aus dem
// App-Bundle importieren, dieselbe Begruendung wie bei READER_BLOCK_SEL in
// share-reader/tts.js. Gegen Drift gesichert durch tests/unit/cite-guard-drift.test.mjs.
export const TTS_SKIP_SEL = 'span.cite[data-src]';

// Eingeblendete Korrekturvorschlaege in der Notebook-Leseansicht (Lektorat-
// Befund bzw. Seiten-Chat-Vorschlag, public/js/book/page-view.js): das <ins>
// steht direkt hinter dem markierten Original. Vorgelesen wird der Text, wie er
// dasteht — nicht Fehler UND Korrektur hintereinander. Highlight und Sprechtext
// teilen auch hier den Offsetraum (ttsUnits ueberspringt beides gleich).
export const TTS_SKIP_DECOR_SEL = 'ins.lektorat-ins, ins.chat-mark-ins';

// ── Bloecke, die gar nicht vorgelesen werden ────────────────────────────────
// Andere Frage als TTS_SKIP_SEL: der oben ueberspringt einen INLINE-Teilbaum
// innerhalb eines Satzes, dieser hier verwirft einen ganzen Block.
//
// Ein Diagramm hat keinen Sprech-Text. Vorzulesen waere entweder sein Quelltext
// („flowchart TD A eckige Klammer auf Ausgangslage") oder die Knoten-Labels des
// gerenderten SVG in Layout-Reihenfolge — beides ist kein Satz und reisst den
// Hoerfluss auseinander. Darum fallen Quelltext-Block UND Render-Knoten weg.
// Die Bildbeschreibung fuer Screenreader haengt am SVG (`role="img"`), das ist
// der richtige Kanal dafuer.
//
// `.mermaid-render` ist der zur Laufzeit eingefuegte Geschwister-Knoten (siehe
// public/js/diagram/mermaid-view.js). Beide Selektoren sind bewusste KOPIEN aus
// public/js/diagram/mermaid-html.js — dieses Modul muss pre-auth ladbar bleiben
// (der Share-Reader importiert es) und darf nichts aus dem App-Bundle ziehen.
// Gegen Drift gesichert durch tests/unit/mermaid-drift.test.mjs.
//
// Eine TABELLE faellt aus demselben Grund weg: vorgelesen waere sie eine Folge
// von Zellen ohne Satzbau („Jahr zweitausenddreiundzwanzig eins Punkt zwei
// Millionen vier Komma eins Prozent"), und der Zusammenhang, den die Spalten
// tragen, entsteht beim Hoeren nicht. Der Zweck des Vorlesens ist das
// Korrekturhoeren der Prosa; eine Zahlenkolonne prueft man mit den Augen.
// Die Beschriftung faellt mit weg: `<caption>` liegt INNERHALB der Tabelle, ein
// Block-Skip nimmt den ganzen Teilbaum. Das ist hier die richtige Wahl — eine
// vorgelesene Beschriftung ohne die Tabelle dahinter kuendigt etwas an, das
// nicht kommt.
// Kopie von public/js/table/table-html.js#TABLE_SEL, gegated durch
// tests/unit/table-drift.test.mjs.
export const TTS_SKIP_BLOCK_SEL = 'pre.mermaid, .mermaid-render, table';


// ── Vorlese-Bloecke ─────────────────────────────────────────────────────────
// Jedes dieser Elemente ist ein eigener Vorlese-Block. Gelesen wird pro Block
// nur sein EIGENER Text: verschachtelte Bloecke (li > ul > li, blockquote > p)
// sind eigene Bloecke und stehen im Elternblock nur als Grenze (siehe ttsUnits).
// So liest `<li>Punkt A<ul><li>Sub</li></ul></li>` erst „Punkt A", dann „Sub" —
// nichts doppelt, nichts verloren. Container ohne eigenen Text (ul, blockquote
// um <p>) liefern einfach keinen Satz.
//
// Enthaelt den Kern aus editor/shared/dom-block.js#TEXT_BLOCK_TAGS (Kopie, weil
// dieses Modul pre-auth ladbar bleiben muss; gegated durch
// tests/unit/block-sel-consolidation.test.mjs) plus `pre`/`figcaption` und die
// reinen Container. Kein td/th/caption: Tabellen fallen ganz weg
// (TTS_SKIP_BLOCK_SEL).
export const TTS_BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, pre, figcaption, '
  + 'ul, ol, dl, dt, dd, div, figure, section, article, aside, header, footer, details, summary';

/** Ist `el` ein Block, der komplett uebersprungen wird? */
export function isTtsSkippedBlock(el) {
  return !!(el && el.nodeType === 1 && el.matches && el.matches(TTS_SKIP_BLOCK_SEL));
}

const isEl = (n) => !!(n && n.nodeType === 1 && n.matches);

// Sprech-Einheiten eines Blocks in Dokumentordnung — EIN Offsetraum fuer
// Sprechtext, Highlight-Range und Klick-Position:
//   { node, text }  ein Textknoten (Laenge = nodeValue.length)
//   { sep,  text }  eine Grenze ohne eigenen Text: <br> oder ein verschachtelter
//                   bzw. uebersprungener Block. Zaehlt als ein Zeichen ('\n'),
//                   damit „Zeile eins<br>Zeile zwei" nicht als „einsZeile"
//                   gesprochen wird und Segmenter dort einen Satz schliesst.
// Beleg-Chips (`skipSel`) fallen ersatzlos weg — sie stehen mitten im Satz,
// die Leerzeichen drumherum traegt der Text.
export function ttsUnits(block, skipSel = TTS_SKIP_SEL) {
  const out = [];
  if (!block) return out;
  const walk = (node) => {
    const kids = node.childNodes;
    if (!kids) return;
    for (const child of kids) {
      if (child.nodeType === 3) {
        if (child.nodeValue) out.push({ node: child, text: child.nodeValue });
        continue;
      }
      if (!isEl(child)) continue;
      if (skipSel && child.matches(skipSel)) continue;
      if (child.matches(TTS_SKIP_DECOR_SEL)) continue;
      if (child.tagName === 'BR' || child.matches(TTS_BLOCK_SEL) || child.matches(TTS_SKIP_BLOCK_SEL)) {
        out.push({ sep: child, text: '\n' });
        continue;
      }
      walk(child);
    }
  };
  walk(block);
  return out;
}

// Textknoten eines Blocks (ohne Chips, ohne verschachtelte Bloecke).
export function ttsTextNodes(root, skipSel = TTS_SKIP_SEL) {
  return ttsUnits(root, skipSel).filter(u => u.node).map(u => u.node);
}

// Sprech-Text eines Blocks — exakt die Verkettung von ttsUnits.
export function ttsBlockText(root, skipSel = TTS_SKIP_SEL) {
  return ttsUnits(root, skipSel).map(u => u.text).join('');
}

// Liegt `el` (oder ein Vorfahre bis `root`) in einem uebersprungenen Teilbaum?
function insideSkipped(el, root) {
  for (let n = el; n && n !== root; n = n.parentNode) {
    if (!isEl(n)) continue;
    if (n.matches(TTS_SKIP_BLOCK_SEL)) return true;
    if (n !== el && n.matches(TTS_SKIP_SEL)) return true;
  }
  return false;
}

// Vorlese-Bloecke unter `root` in Dokumentordnung, `root` selbst zuerst (Text,
// der direkt im Container steht). Bloecke in Tabellen/Diagrammen fallen weg.
export function ttsBlocks(root) {
  if (!root || !root.querySelectorAll) return [];
  const list = [root, ...root.querySelectorAll(TTS_BLOCK_SEL)];
  return list.filter(b => b === root || !insideSkipped(b, root));
}

const HAS_WORD = /[\p{L}\p{N}]/u;

// Vorlese-Segmente unter `root`: pro Block die Saetze (Locale = Buchsprache),
// gechunkt (chunkTtsRanges). Segmente ohne Buchstaben/Ziffern (Szenentrenner
// „* * *", lose Satzzeichen) fallen weg. Ergebnis: { text, block, startOff,
// endOff } — Offsets im Offsetraum von ttsUnits(block).
export function collectTtsSegments(root, locale = 'de') {
  const segs = [];
  for (const block of ttsBlocks(root)) {
    const text = ttsBlockText(block);
    if (!HAS_WORD.test(text)) continue;
    const ranges = computeTtsSentences(text, locale);
    const base = ranges.length ? ranges : [[0, text.length]];
    for (const [s, e] of chunkTtsRanges(base, text)) {
      const t = text.slice(s, e).trim();
      if (t && HAS_WORD.test(t)) segs.push({ text: t, block, startOff: s, endOff: e });
    }
  }
  return segs;
}

// Hat `root` ueberhaupt vorlesbaren Text? (Dock-Sichtbarkeit: eine Seite aus
// nur einer Tabelle oder einem Diagramm zeigt keinen Vorlese-Knopf.)
export function hasTtsText(root) {
  return ttsBlocks(root).some(b => HAS_WORD.test(ttsBlockText(b)));
}

// DOM-Range fuer [start, end) im Offsetraum von ttsUnits(block). Grenz-Einheiten
// werden nie mitmarkiert: ein Satz, der an einem verschachtelten Block endet,
// soll nicht die ganze Unterliste einfaerben.
export function ttsBuildRange(block, start, end) {
  if (!block || !block.isConnected) return null;
  const doc = block.ownerDocument;
  const units = ttsUnits(block);
  let pos = 0;
  let startSet = false;
  let r;
  try { r = doc.createRange(); } catch { return null; }
  try {
    for (const u of units) {
      const len = u.text.length;
      if (!startSet && start < pos + len) {
        if (u.node) r.setStart(u.node, Math.max(0, start - pos));
        else r.setStartAfter(u.sep);
        startSet = true;
      }
      if (startSet && end <= pos + len) {
        if (u.node) r.setEnd(u.node, Math.max(0, Math.min(end - pos, len)));
        else r.setEndBefore(u.sep);
        return r;
      }
      pos += len;
    }
    if (!startSet) return null;
    const last = units[units.length - 1];
    if (last.node) r.setEnd(last.node, last.text.length);
    else r.setEndBefore(last.sep);
    return r;
  } catch { return null; }
}

// Offset eines DOM-Punkts (Textknoten + Offset) im Offsetraum des Blocks, oder
// null, wenn der Punkt nicht im eigenen Text des Blocks liegt.
export function ttsOffsetAt(block, node, offset) {
  let pos = 0;
  for (const u of ttsUnits(block)) {
    if (u.node === node) return pos + Math.max(0, Math.min(offset, u.text.length));
    if (u.sep && u.sep.contains && u.sep.contains(node)) return null;
    pos += u.text.length;
  }
  return null;
}

// Index des Segments, in dem der DOM-Punkt liegt (Klick „ab hier" / Start ab
// Markierung). -1, wenn der Punkt in keinem Segment liegt.
export function ttsSegmentAt(segs, node, offset) {
  if (!node || !Array.isArray(segs)) return -1;
  let fallback = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s.block || !s.block.contains || !s.block.contains(node)) continue;
    const off = ttsOffsetAt(s.block, node, offset);
    if (off == null) {
      // Punkt auf einem Element statt einem Textknoten: erster Satz eines
      // Blocks, der ihn enthaelt.
      if (node.nodeType === 1 && fallback < 0) fallback = i;
      continue;
    }
    if (off < s.endOff) return i;
    fallback = i;
  }
  return fallback;
}

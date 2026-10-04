'use strict';
// Satz- und Wortzerlegung der Stil-Metriken ([lib/page-index.js](./page-index.js)
// #computeStyleStats). Eigenes Modul, weil die Regeln — Abkürzungen,
// Ordinalzahlen, Dialog-Einschübe — ein eigenes Thema sind und page-index.js sonst
// über sein LOC-Limit wüchse. Änderung hier ⇒ METRICS_VERSION in page-index.js
// erhöhen, sonst bleiben alte Werte in page_stats stehen.

// Abkürzungen, deren Punkt keinen Satz beendet (kleingeschrieben, ohne Punkt).
// Einbuchstabige Kürzel („z. B.", „d. h.", Initialen) fängt die Längenregel in
// sentenceRanges ab und brauchen keinen Eintrag.
const _ABBREVIATIONS = new Set([
  'usw', 'bzw', 'ca', 'dr', 'prof', 'hr', 'fr', 'frl', 'nr', 'st', 'vgl', 'evtl',
  'ggf', 'inkl', 'exkl', 'bspw', 'sog', 'mio', 'mrd', 'abs', 'art', 'jh', 'jhd',
  'chr', 'etc', 'max', 'min', 'tel', 'str', 'bzgl', 'zzgl', 'gegr', 'geb', 'gest',
  'mr', 'mrs', 'ms', 'jr', 'sr', 'vs', 'co', 'hl', 'ff', 'insb', 'allg', 'ggü',
]);
// Satzende: Terminator (auch „…"), optional schliessende Anführungszeichen/
// Klammern, danach Leerraum oder Textende.
const _SENTENCE_END_RE = /[.!?…]+["'»«“”„‘’‹›)\]]*(?=\s|$)/g;

// Satzgrenzen inkl. Offsets: [[start, end], …] in Leserichtung. EINE Zerlegung
// für Satzlängen, Satzanfänge, LIX/Flesch und die Drilldown-Beispiele.
// Kein Satzende ist:
//   - ein einzelner Punkt nach einer Abkürzung, einem Einzelbuchstaben oder einer
//     Zahl („z. B.", „Dr. Meier", „am 3. Mai")
//   - ein Terminator, nach dem es kleingeschrieben weitergeht — Dialog-Einschub
//     („Komm!", rief er.), Auslassung mitten im Satz („Er … ging"), Abkürzung
//     ausserhalb der Liste.
// Ein blosser Split an [.!?] machte aus jedem dieser Fälle zwei Kurzsätze und
// drückte Satzlänge, P90 und LIX systematisch nach unten.
function sentenceRanges(text) {
  const ranges = [];
  if (!text) return ranges;
  let start = 0;
  let m;
  _SENTENCE_END_RE.lastIndex = 0;
  while ((m = _SENTENCE_END_RE.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (m[0][0] === '.' && m[0][1] !== '.') {
      const prev = /([\p{L}\d]+)$/u.exec(text.slice(Math.max(start, m.index - 24), m.index));
      const w = prev ? prev[1] : '';
      if (w && (/^\d+$/.test(w) || w.length === 1 || _ABBREVIATIONS.has(w.toLowerCase()))) continue;
    }
    const next = /^\s*(\S)/.exec(text.slice(end, end + 8));
    if (next && /\p{Ll}/u.test(next[1])) continue;
    if (/[\p{L}\d]/u.test(text.slice(start, end))) ranges.push([start, end]);
    start = end;
  }
  if (start < text.length && /[\p{L}\d]/u.test(text.slice(start))) ranges.push([start, text.length]);
  return ranges;
}

// Wörter der Stil-Metriken: Buchstabenfolgen in allen Schriften (é, à, ø, …),
// nicht nur A–Z + Umlaute — sonst zerfiele „Crème" in zwei Wörter.
const STYLE_WORD_RE = /\p{L}+/gu;

module.exports = { sentenceRanges, STYLE_WORD_RE };

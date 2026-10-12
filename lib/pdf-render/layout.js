'use strict';
// Page-Geometrie + Kapitel-Numerierung. Reine Funktionen, keine pdfkit-State-Mutation.

const MM_TO_PT = 72 / 25.4;
const PAGE_DIMS_PT = {
  A4:     [595.28, 841.89],
  A5:     [419.53, 595.28],
  A6:     [297.64, 419.53],
  Letter: [612, 792],
};

function _pageSize(layout) {
  if (layout.pageSize === 'custom') {
    return [layout.customWidthMm * MM_TO_PT, layout.customHeightMm * MM_TO_PT];
  }
  return PAGE_DIMS_PT[layout.pageSize] || PAGE_DIMS_PT.A4;
}

function _romanize(num) {
  if (num <= 0) return String(num);
  const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
  let out = '';
  for (const [r, v] of map) while (num >= v) { out += r; num -= v; }
  return out;
}

// Kapitelnummer als Wort, 1–99. Ab 100 arabisch — „Kapitel Einhundertzwölf"
// liest niemand. Deutsch zusammengesetzt mit „und" (Einundzwanzig), Englisch
// mit Bindestrich (Twenty-One). Die Buch-Region entscheidet die Rechtschreibung:
// Schweiz und Liechtenstein schreiben ss statt ß („Dreissig").
const _DE_UNITS = ['', 'Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht', 'Neun',
  'Zehn', 'Elf', 'Zwölf', 'Dreizehn', 'Vierzehn', 'Fünfzehn', 'Sechzehn', 'Siebzehn', 'Achtzehn', 'Neunzehn'];
const _DE_TENS = ['', '', 'Zwanzig', 'Dreißig', 'Vierzig', 'Fünfzig', 'Sechzig', 'Siebzig', 'Achtzig', 'Neunzig'];
const _EN_UNITS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const _EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const _SS_REGIONS = new Set(['CH', 'LI']);

function _wordize(num, lang, region) {
  if (!Number.isInteger(num) || num < 1 || num > 99) return String(num);
  const l = String(lang || 'de').toLowerCase();
  if (l.startsWith('en')) {
    if (num < 20) return _EN_UNITS[num];
    const t = _EN_TENS[Math.floor(num / 10)], u = num % 10;
    return u ? `${t}-${_EN_UNITS[u]}` : t;
  }
  let w;
  if (num < 20) w = _DE_UNITS[num];
  else {
    const t = _DE_TENS[Math.floor(num / 10)], u = num % 10;
    w = u ? `${u === 1 ? 'Ein' : _DE_UNITS[u]}und${t.toLowerCase()}` : t;
  }
  return _SS_REGIONS.has(String(region || '').toUpperCase()) ? w.replace(/ß/g, 'ss') : w;
}

function _chapterLabel(numbering, idx, lang, region) {
  switch (numbering) {
    case 'arabic': return String(idx);
    case 'roman':  return _romanize(idx);
    case 'word':   return _wordize(idx, lang, region);
    default:       return null;
  }
}

// Hierarchisches Label: counters = [topIdx, subIdx, subSubIdx], depth ∈ {1,2,3}.
// `mode`: 'flat' → nur counters[depth-1]; 'nested' → counters[0..depth-1].join('.').
// Unterebenen sind immer arabisch. Roemisch bleibt oben stehen („III.2" ist
// gaengig), das Wort nicht: „Drei.2" mischt Wort und Ziffer — dann ganz arabisch.
function _chapterLabelNested(numbering, counters, depth, mode, lang, region) {
  if (!numbering || numbering === 'none') return null;
  if (depth <= 1 || mode === 'flat') {
    return _chapterLabel(numbering, counters[depth - 1] || 0, lang, region);
  }
  // nested: top-Label im Original-Format (Wort → arabisch), Sub-Ebenen arabisch.
  const top = _chapterLabel(numbering === 'word' ? 'arabic' : numbering, counters[0] || 0, lang);
  const tail = counters.slice(1, depth).map(n => String(n || 0)).join('.');
  return `${top}.${tail}`;
}

// Buffered-Page-Index-Helper: pdfkit fügt Seiten in `bufferedPages` an; der
// Index der zuletzt angelegten Seite ist start+count-1, der der nächsten
// start+count. Ersetzt das mehrfach vorkommende Inline-Idiom.
function _currentPageIdx(doc) {
  const r = doc.bufferedPageRange();
  return r.start + r.count - 1;
}
function _nextPageIdx(doc) {
  const r = doc.bufferedPageRange();
  return r.start + r.count;
}
// Verso = linke/gerade Buchseite. 0-basierter Page-Index: gerade = recto,
// ungerade = verso. Physische Seiteneigenschaft, unabhängig von mirrorMargins.
function _isVersoPageIdx(idx) { return idx % 2 === 1; }

module.exports = {
  MM_TO_PT, PAGE_DIMS_PT, _pageSize, _romanize, _chapterLabel, _chapterLabelNested,
  _currentPageIdx, _nextPageIdx, _isVersoPageIdx,
};

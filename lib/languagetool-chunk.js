'use strict';
// Zerlegt den LT-Eingabetext in Absatz-Segmente (Cache-Einheit des Proxys) und
// packt die nicht gecachten Segmente zu Upstream-Anfragen <= CHUNK_MAX.
//
// Offsets sind UTF-16 Code Units (= JS String.length = LT-Offset-Semantik).
//
//   splitSegments(text)       -> [{ text, offset }]  ein Eintrag pro Absatz
//                                (Trenner `\n{2,}`), Leer-/Whitespace-Absaetze
//                                fallen weg. Ein Absatz > max wird an Satz-
//                                grenzen, notfalls an Wortgrenzen geteilt.
//   packSegments(segs, max)   -> [{ text, parts: [{ index, offset, length }] }]
//                                Segmente mit `\n\n` verbunden; `offset` ist die
//                                Position des Segments im gepackten Text.
//   assignMatches(batch, ms)  -> Map<index, matches[]> mit Offsets RELATIV zum
//                                Segment. Ein Treffer, der ueber eine Segment-
//                                grenze reicht, wird verworfen — er gehoert zu
//                                keinem Absatz allein und waere nicht cachebar.

const CHUNK_MAX = 50_000;
const SEP = '\n\n';

function splitSegments(input, max = CHUNK_MAX) {
  const text = typeof input === 'string' ? input : '';
  const out = [];
  if (!text) return out;
  const push = (t, offset) => {
    if (!t.trim()) return;
    if (t.length <= max) { out.push({ text: t, offset }); return; }
    for (const s of _splitSentences(t, max, offset)) {
      if (s.text.length > max) for (const h of _hardSplit(s.text, max, s.offset)) out.push(h);
      else out.push(s);
    }
  };
  const re = /\n{2,}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index), last);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last), last);
  return out;
}

function packSegments(segments, max = CHUNK_MAX) {
  const batches = [];
  let cur = null;
  segments.forEach((seg, index) => {
    const extra = cur && cur.text ? SEP.length : 0;
    if (!cur || (cur.text.length + extra + seg.text.length > max && cur.parts.length)) {
      cur = { text: '', parts: [] };
      batches.push(cur);
    }
    if (cur.text) cur.text += SEP;
    cur.parts.push({ index, offset: cur.text.length, length: seg.text.length });
    cur.text += seg.text;
  });
  return batches;
}

function assignMatches(batch, matches) {
  const byIndex = new Map();
  for (const p of batch.parts) byIndex.set(p.index, []);
  if (!Array.isArray(matches)) return byIndex;
  for (const m of matches) {
    if (!m || typeof m.offset !== 'number') continue;
    const len = Number(m.length) || 0;
    const part = _findPart(batch.parts, m.offset);
    if (!part || m.offset + len > part.offset + part.length) continue;
    byIndex.get(part.index).push({ ...m, offset: m.offset - part.offset });
  }
  return byIndex;
}

function _findPart(parts, offset) {
  let lo = 0;
  let hi = parts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = parts[mid];
    if (offset < p.offset) hi = mid - 1;
    else if (offset >= p.offset + p.length) lo = mid + 1;
    else return p;
  }
  return null;
}

function _splitSentences(text, max, baseOffset) {
  const re = /([.!?\n]+\s*)/g;
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    parts.push({ text: text.slice(lastIdx, end), offset: baseOffset + lastIdx });
    lastIdx = end;
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), offset: baseOffset + lastIdx });
  }

  const out = [];
  let buf = '';
  let bufOffset = -1;
  for (const p of parts) {
    if (p.text.length > max) {
      if (buf) { out.push({ text: buf, offset: bufOffset }); buf = ''; bufOffset = -1; }
      out.push(p);
      continue;
    }
    if (buf.length + p.text.length > max) {
      out.push({ text: buf, offset: bufOffset });
      buf = '';
      bufOffset = -1;
    }
    if (!buf) { buf = p.text; bufOffset = p.offset; }
    else { buf += p.text; }
  }
  if (buf) out.push({ text: buf, offset: bufOffset });
  return out;
}

function _hardSplit(text, max, baseOffset) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const minEnd = i + Math.floor(max * 0.8);
      let cut = end;
      for (let j = end; j > minEnd; j--) {
        if (/\s/.test(text[j])) { cut = j + 1; break; }
      }
      end = cut;
    }
    out.push({ text: text.slice(i, end), offset: baseOffset + i });
    i = end;
  }
  return out;
}

module.exports = { splitSegments, packSegments, assignMatches, CHUNK_MAX };

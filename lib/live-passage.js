'use strict';
// Aktuelle Textstelle zu einem Index-Chunk. Der Embedding-Index ist ein
// Ableitungs-Index: sein Chunk-Text kann hinter dem Seitenstand zurückliegen
// (Seite seit dem letzten embed-index-Lauf bearbeitet). Wer einem Modell eine
// Stelle als Beleg zeigt oder ein Zitat dagegen prüft, braucht den LIVE-Text —
// der Chunk taugt nur noch als Wegweiser, WO auf der Seite zu suchen ist.
//
// `bestLivePassage` sucht im aktuellen Seitentext das Wortfenster, das die
// Wörter des Chunks am besten abdeckt (wörtlich enthaltener Chunk → Abdeckung
// 1), und schneidet es aus dem Originaltext (Absätze/Satzzeichen bleiben
// erhalten). Unter `minOverlap` gibt es null: die Stelle ist umgeschrieben oder
// gelöscht, und ein unverwandter Absatz wäre ein falscher Beleg.
//
// Wortvergleich statt Zeichenvergleich, damit die zwei HTML→Text-Varianten
// (einzeilig für den Index, absatz-erhaltend für Prompts) und typografische
// Anführungszeichen denselben Fund liefern.

const _WORD = /[\p{L}\p{N}]+/gu;

function _words(text) {
  const out = [];
  const s = String(text || '');
  _WORD.lastIndex = 0;
  let m;
  while ((m = _WORD.exec(s))) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * @param {string} liveText aktueller Seitentext (Klartext)
 * @param {string} chunkText Text des Index-Treffers (Wegweiser)
 * @param {{ maxChars?: number, minOverlap?: number }} [opts]
 * @returns {{ text: string, overlap: number, exact: boolean } | null}
 */
function bestLivePassage(liveText, chunkText, { maxChars = 1200, minOverlap = 0.5 } = {}) {
  const live = String(liveText || '');
  const lw = _words(live);
  const cw = _words(chunkText).map(x => x.w);
  if (!lw.length || !cw.length) return null;

  const need = new Map();
  for (const w of cw) need.set(w, (need.get(w) || 0) + 1);
  const n = Math.min(cw.length, lw.length);

  // Gleitendes Fenster über n Wörter: Abdeckung = Anteil der Chunk-Wörter
  // (mit Vielfachheit), die das Fenster enthält. O(|live|) mit Zählern.
  const have = new Map();
  let hit = 0;
  const add = (w) => { const c = (have.get(w) || 0) + 1; have.set(w, c); if (c <= (need.get(w) || 0)) hit++; };
  const drop = (w) => { const c = have.get(w); have.set(w, c - 1); if (c <= (need.get(w) || 0)) hit--; };
  for (let i = 0; i < n; i++) add(lw[i].w);
  let best = hit, bestAt = 0;
  for (let i = n; i < lw.length; i++) {
    add(lw[i].w);
    drop(lw[i - n].w);
    if (hit > best) { best = hit; bestAt = i - n + 1; }
  }
  const overlap = best / cw.length;
  if (overlap < minOverlap) return null;

  let from = lw[bestAt].start;
  let to = lw[bestAt + n - 1].end;
  // Auf maxChars zuschneiden (mittig um das Fenster) bzw. bis dahin auffüllen,
  // damit der Beleg einen ganzen Gedanken trägt.
  if (to - from > maxChars) {
    to = from + maxChars;
  } else {
    const pad = Math.floor((maxChars - (to - from)) / 2);
    from = Math.max(0, from - pad);
    to = Math.min(live.length, to + pad);
  }
  // An Wortgrenzen ausrichten, nicht mitten im Wort schneiden.
  while (from > 0 && /[\p{L}\p{N}]/u.test(live[from - 1])) from--;
  while (to < live.length && /[\p{L}\p{N}]/u.test(live[to])) to++;
  return { text: live.slice(from, to).trim(), overlap, exact: best === cw.length };
}

module.exports = { bestLivePassage };

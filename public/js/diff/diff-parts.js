// Darstellung eines Wort-Diffs — geteilt von allen Diff-Ansichten:
// Abschnitts-Historie, Fassungsvergleich und Fassungs-Leseansicht
// (page-revision-diff.js, HTML-String), Kommentar-Leisten («Stelle geändert»),
// Konflikt-Auflösung aller drei Editoren (editor/shared/conflict-diff.js) und
// die Vorschlagskarten von Abschnitts-, Plot- und Ideen-Chat (Alpine-Templates).
//
// Ein Teile-Modell, eine Markierung: `{ t: 'eq'|'del'|'add', v, c }`, `c` ist
// die CSS-Klasse (components/diff-marks.css). Templates binden `:class="part.c"`
// und `x-text="part.v"`; HTML-Konsumenten nehmen partsToHtml (escaped).
//
// Pure — kein DOM, kein Alpine.

import { escHtml } from '../utils.js';
import { wordDiff } from './word-diff.js';

// Rand-Whitespace einer Änderung steht ausserhalb der Marke, sonst läuft
// Hinterlegung und Strich über die Lücke. Reine Satzzeichen (`"` → `«`)
// bekommen `diff-mark--punct` — ein Durchstreich-Strich auf halber Höhe liegt
// unter einem hochgestellten Anführungszeichen und liest sich als Abstand statt
// als Löschung; dort markiert die Hinterlegung allein.
function _mark(p, out) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(p.v);
  if (!m[2]) { out.push({ t: p.t, v: p.v, c: _cls(p.t, false) }); return; }
  if (m[1]) _eq(m[1], out);
  out.push({ t: p.t, v: m[2], c: _cls(p.t, !/[\p{L}\p{N}]/u.test(m[2])) });
  if (m[3]) _eq(m[3], out);
}

// Gleichtext an einen vorangehenden Gleichtext hängen statt ein neues Stück
// anzufangen (abgespaltener Rand-Whitespace, gefilterte Gegenseite).
function _eq(v, out) {
  const last = out[out.length - 1];
  if (last?.t === 'eq') last.v += v;
  else out.push({ t: 'eq', v, c: '' });
}

function _cls(t, punct) {
  const base = t === 'del' ? 'diff-del' : t === 'add' ? 'diff-add' : '';
  return punct && base ? `${base} diff-mark--punct` : base;
}

/**
 * Teile für eine Ansicht: `side` 'old' (eq + del), 'new' (eq + add) oder
 * 'both' (alles, Lesefluss). Erst filtern, dann markieren — sonst stünde der
 * Rand-Whitespace einer Löschung als Gleichtext in der Neu-Spalte.
 * @param {Array<{t:string,v:string}>|null} parts
 * @param {'old'|'new'|'both'} [side]
 * @returns {Array<{t:string,v:string,c:string}>|null}
 */
export function markParts(parts, side = 'both') {
  if (!parts) return null;
  const out = [];
  for (const p of parts) {
    if (side === 'old' && p.t === 'add') continue;
    if (side === 'new' && p.t === 'del') continue;
    if (p.t === 'eq') _eq(p.v, out);
    else _mark(p, out);
  }
  return out;
}

/**
 * Wort-Diff zweier Klartexte als Teile. `diffLib` (jsdiff, optional) springt ein,
 * wenn der Text für die LCS-Tabelle von wordDiff zu gross ist; ohne diffLib
 * bleibt es dann bei `null`.
 */
export function wordParts(a, b, diffLib = null) {
  const parts = wordDiff(a, b);
  if (parts || typeof diffLib?.diffWords !== 'function') return parts;
  return diffLib.diffWords(a, b).map(p => ({ t: p.added ? 'add' : p.removed ? 'del' : 'eq', v: p.value }));
}

/** Markierte Teile beider Seiten im Lesefluss — für die Chat-Vorschlagskarten. */
export function diffParts(a, b) {
  return markParts(wordDiff(a, b), 'both');
}

/**
 * Markierte Teile → HTML. Änderungen als `<del>`/`<ins>`, Gleichtext als
 * `<span class="eqClass">` oder, ohne eqClass, als blosser Text.
 */
export function partsToHtml(parts, eqClass = '') {
  let html = '';
  for (const p of parts || []) {
    const v = escHtml(p.v);
    if (p.t === 'del') html += `<del class="${p.c}">${v}</del>`;
    else if (p.t === 'add') html += `<ins class="${p.c}">${v}</ins>`;
    else html += eqClass ? `<span class="${eqClass}">${v}</span>` : v;
  }
  return html;
}

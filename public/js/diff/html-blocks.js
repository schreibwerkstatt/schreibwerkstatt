// Block-HTML → Lesetext für Diff-Ansichten. Eine Extraktion für alle:
// Abschnitts-Historie, Fassungen und Kommentar-Leisten (page-revision-diff.js,
// je Blattblock ein Diff-Eintrag) und Konflikt-Auflösung (conflict-diff.js,
// ein Block als Klartext mit Zeilenumbrüchen).
//
// Pure — Browser-Pfad über DOMParser (dekodiert jede Entity, kennt Nesting),
// Node-Pfad über Regex, damit die Tests ohne DOM laufen.
// Nur Anzeige: übernommen/gespeichert wird immer das rohe HTML.

import { decodeEntities, htmlToPlainText } from '../html-text.js';

// Blattblöcke: nur Elemente, die selbst keinen weiteren Block enthalten.
// Container (`blockquote > p`, `li > p`, `ul`, `table`) liefern ihren Text über
// die Kinder — sonst stünde derselbe Text doppelt im Diff, einmal davon ohne
// Trennzeichen zusammengeklebt (`textContent` eines Containers).
// `td`/`th`/`caption`/`figcaption`/`dt`/`dd`: Tabellen- und Bildtexte zählen
// wie Absätze (docs/tabellen.md — Zellinhalt ist Text).
const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre',
  'td', 'th', 'caption', 'figcaption', 'dt', 'dd'];
const BLOCK_SEL = BLOCK_TAGS.join(',');
const _TAGS_ALT = BLOCK_TAGS.join('|');
// Regex-Pfad: Blattblock = Inhalt ohne öffnendes Block-Tag.
const LEAF_RE = new RegExp(`<(${_TAGS_ALT})\\b[^>]*>((?:(?!<(?:${_TAGS_ALT})\\b)[\\s\\S])*?)<\\/\\1>`, 'gi');
const IMG_RE = /<img\b[^>]*>/gi;
const SKIP_RE = /<(script|style)\b[\s\S]*?<\/\1>/gi;

function _imgName(alt, src) {
  if (alt && alt.trim()) return alt.trim();
  const s = String(src || '');
  if (!s || s.startsWith('data:')) return '';
  const last = s.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  try { return decodeURIComponent(last); } catch { return last; }
}

function _attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
}

// `<br>` trennt Zeilen: mit `breaks` als Zeilenumbruch, sonst als Leerzeichen —
// nie als nichts, sonst klebten «Zeile eins<br>Zeile zwei» zusammen.
function _squash(s, breaks) {
  if (!breaks) return s.replace(/\s+/g, ' ').trim();
  return s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function _domText(el, breaks) {
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') s += breaks ? '\n' : ' ';
      else if (tag !== 'script' && tag !== 'style') s += _domText(n, breaks);
    }
  }
  return s;
}

// Inline-Markup fällt ohne Ersatz-Leerzeichen weg (`<b>ging</b>.` bleibt `ging.`).
function _regexText(inner, breaks) {
  return _squash(decodeEntities(String(inner)
    .replace(SKIP_RE, '')
    .replace(/<br\s*\/?>/gi, breaks ? '\n' : ' ')
    .replace(/<[^>]*>/g, '')), breaks);
}

function _parseDOM(html, imageLabel, breaks) {
  if (typeof DOMParser === 'undefined') return null;
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const sel = imageLabel ? `${BLOCK_SEL},img` : BLOCK_SEL;
    const nodes = doc.body ? doc.body.querySelectorAll(sel) : [];
    if (!nodes.length) {
      const text = doc.body ? _squash(_domText(doc.body, breaks), breaks) : '';
      return text ? [{ tag: 'p', text }] : [];
    }
    const out = [];
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') {
        out.push({ tag: 'img', text: imageLabel(_imgName(el.getAttribute('alt'), el.getAttribute('src'))) });
        continue;
      }
      if (el.querySelector(BLOCK_SEL)) continue;
      const text = _squash(_domText(el, breaks), breaks);
      if (text) out.push({ tag, text });
    }
    return out;
  } catch { return null; }
}

/**
 * HTML → Blattblöcke `[{ tag, text }]` in Dokument-Reihenfolge.
 * `opts.imageLabel(name)`: Bilder als eigene Blöcke (Name = alt oder
 * Dateiname), damit ein eingefügtes/gelöschtes Bild im Vergleich erscheint.
 * Ohne die Option fallen Bilder weg (Fassungs- und Kommentar-Diffs).
 * `opts.breaks`: `<br>` als Zeilenumbruch im Text behalten (Konflikt-Ansicht).
 */
export function parseBlocks(html, opts = {}) {
  const imageLabel = typeof opts.imageLabel === 'function' ? opts.imageLabel : null;
  const breaks = !!opts.breaks;
  const dom = _parseDOM(html, imageLabel, breaks);
  if (dom !== null) return dom;
  const src = String(html || '');
  const matches = [...src.matchAll(LEAF_RE)];
  if (!matches.length) {
    const text = breaks ? _regexText(src, true) : htmlToPlainText(src);
    return text ? [{ tag: 'p', text }] : [];
  }
  const out = [];
  const pushImgs = (frag) => {
    if (!imageLabel) return;
    for (const im of frag.matchAll(IMG_RE)) {
      out.push({ tag: 'img', text: imageLabel(_imgName(_attr(im[0], 'alt'), _attr(im[0], 'src'))) });
    }
  };
  let pos = 0;
  for (const m of matches) {
    pushImgs(src.slice(pos, m.index));
    const tag = m[1].toLowerCase();
    const text = _regexText(m[2], breaks);
    if (text) out.push({ tag, text });
    pushImgs(m[2]);
    pos = m.index + m[0].length;
  }
  pushImgs(src.slice(pos));
  return out;
}

/**
 * Ein Block (oder Block-Container wie Liste/Tabelle/Zitat) als Klartext: innere
 * Blöcke auf eigenen Zeilen, `<br>` als Zeilenumbruch.
 */
export function blockText(html) {
  if (!html) return '';
  return parseBlocks(html, { breaks: true }).map(b => b.text).join('\n');
}

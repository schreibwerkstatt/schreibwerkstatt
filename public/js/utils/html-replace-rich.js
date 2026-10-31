// Ersatz mit Auszeichnung und Absatzteilung — Erweiterung von `replaceInHtml`
// (html-find.js) für den Abschnitts-Chat. Ein Chat-`ersatz` darf zwei Dinge
// tragen, die eine Lektorat-`korrektur` nie trägt:
//   - `*kursiv*` / `**fett**` (auch `_kursiv_`) → echtes `<em>` / `<strong>`
//   - eine Leerzeile → der Absatz wird an dieser Stelle in zwei `<p>` geteilt
// Ohne beides delegiert alles unverändert an `replaceInHtml`.
//
// MECHANIK: Auszeichnung und Absatzwechsel reisen als Zeichen der Private-Use-
// Area durch `replaceInHtml` (dessen Maskierung und Wort-Diff fassen sie als
// gewöhnliche Satzzeichen-Token an) und werden danach in Markup übersetzt.
// Zwei Prüfungen danach:
//   - Inline-Tags sauber verschachtelt? Sonst (Wort-Diff legte ein `<em>` quer
//     über eine bestehende Auszeichnung) fällt die Auszeichnung weg und nur der
//     Klartext wird eingesetzt — nie Sternchen im Buch, nie kaputtes Markup.
//   - Absatzwechsel nur in einem schlichten `<p>` (auch im `<blockquote>`), nie
//     in Listen, Tabellen, Abbildungen, `<pre>`, Gedicht- oder Nachrichten-
//     Blöcken (`div`) und nie innerhalb eines Links oder einer Marker-Span
//     (Quellenangabe/Querverweis). Sonst No-Op → `richSkipReason` meldet
//     'paragraphSplit'. Der neue Absatz erbt Klasse/Attribute des alten ohne
//     `data-bid`/`id` (die Block-ID vergibt der Write-Pfad bzw. block-ids.js).

import { replaceInHtml, skipReason } from './html-find.js';

const EM_O = '', EM_C = '', ST_O = '', ST_C = '', PARA = '';
const SENTINELS_RE = /[-]/g;
const PARA_SPLIT_RE = /\n[ \t]*\n\s*/;

const STRONG_RE = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const EM_STAR_RE = /(^|[^\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu;
const EM_UNDER_RE = /(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu;

function _markParagraph(s, { open = true } = {}) {
  const o = (a) => (open ? a : '');
  return s
    .replace(STRONG_RE, (_, x) => `${o(ST_O)}${x}${o(ST_C)}`)
    .replace(EM_STAR_RE, (_, pre, x) => `${pre}${o(EM_O)}${x}${o(EM_C)}`)
    .replace(EM_UNDER_RE, (_, pre, x) => `${pre}${o(EM_O)}${x}${o(EM_C)}`);
}

/** Zerlegt einen Ersatz in Absätze; `marked` mit Sentinels, `plain` ohne
 *  Auszeichnungs-Zeichen. */
export function parseRichReplacement(replacement) {
  const raw = String(replacement ?? '').replace(/\r\n?/g, '\n').replace(SENTINELS_RE, '').trim();
  const paras = raw.split(PARA_SPLIT_RE).map(p => p.trim()).filter(Boolean);
  const marked = paras.map(p => _markParagraph(p));
  const plain = paras.map(p => _markParagraph(p, { open: false }));
  const hasMarkup = marked.some((m, i) => m !== plain[i]);
  return { paras: plain, marked, hasMarkup, split: paras.length > 1 };
}

/** Der Text, der nach dem Übernehmen im Abschnitt steht (für Suchen/Zählen,
 *  Rückgängig, Anzeige): ohne Auszeichnungs-Zeichen, Absätze durch Leerzeile. */
export function richReplacementText(replacement) {
  return parseRichReplacement(replacement).paras.join('\n\n');
}

/** Teilt der Ersatz einen Absatz? */
export function replacementSplitsParagraph(replacement) {
  return parseRichReplacement(replacement).split;
}

const _VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

function _balanced(html) {
  const stack = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    const tag = m[2].toLowerCase();
    if (_VOID.has(tag) || m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

// Offene Elemente an Position `pos`: [{ tag, open }] von aussen nach innen.
function _openStack(html, pos) {
  const stack = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) && m.index < pos) {
    const tag = m[2].toLowerCase();
    if (_VOID.has(tag) || m[3]) continue;
    if (m[1]) {
      const i = stack.map(s => s.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
    } else {
      stack.push({ tag, open: m[0] });
    }
  }
  return stack;
}

const SPLIT_INLINE = new Set(['em', 'strong', 'b', 'i', 'u', 's', 'mark', 'small', 'sub', 'sup', 'span']);
const SPLIT_FORBIDDEN_ANCESTORS = new Set(['pre', 'table', 'figure', 'li', 'ul', 'ol', 'div', 'dl', 'details']);
const MARKER_SPAN_RE = /\bclass\s*=\s*"[^"]*\b(cite|xref)\b/i;

// Ersetzt jeden PARA durch `</…></p><p …><…>`. null = an einer Stelle nicht teilbar.
function _splitAtParagraphMarks(html) {
  let out = html.replace(new RegExp(`(?:\\s|&nbsp;)*${PARA}(?:\\s|&nbsp;)*`, 'g'), PARA);
  let pos;
  while ((pos = out.indexOf(PARA)) >= 0) {
    const stack = _openStack(out, pos);
    const pIdx = stack.map(s => s.tag).lastIndexOf('p');
    if (pIdx < 0) return null;
    if (stack.slice(0, pIdx).some(s => SPLIT_FORBIDDEN_ANCESTORS.has(s.tag))) return null;
    const inline = stack.slice(pIdx + 1);
    if (inline.some(s => !SPLIT_INLINE.has(s.tag) || (s.tag === 'span' && MARKER_SPAN_RE.test(s.open)))) return null;
    const pOpen = stack[pIdx].open.replace(/\s+(?:data-bid|id)\s*=\s*"[^"]*"/gi, '');
    const closes = inline.slice().reverse().map(s => `</${s.tag}>`).join('');
    const opens = inline.map(s => s.open).join('');
    out = out.slice(0, pos) + closes + '</p>' + pOpen + opens + out.slice(pos + 1);
  }
  return out.replace(/<(em|strong|b|i|u|s|mark|small|sub|sup)>\s*<\/\1>/gi, '').replace(/<p\b[^>]*>\s*<\/p>/gi, '');
}

function _withInlineMarkup(s) {
  return s.replaceAll(EM_O, '<em>').replaceAll(EM_C, '</em>').replaceAll(ST_O, '<strong>').replaceAll(ST_C, '</strong>');
}

/**
 * Wie `replaceInHtml`, zusätzlich mit `*kursiv*`/`**fett**` und Absatzteilung
 * (siehe Modulkopf). Gibt `html` unverändert zurück, wenn nicht ersetzbar.
 */
export function replaceInHtmlRich(html, needle, replacement) {
  const { paras, marked, hasMarkup, split } = parseRichReplacement(replacement);
  if (!hasMarkup && !split) return replaceInHtml(html, needle, replacement);
  if (!paras.length) return html;
  const attempt = (parts) => {
    const out = replaceInHtml(html, needle, parts.join(` ${PARA} `));
    if (out === html) return html;
    const withMarkup = _withInlineMarkup(out);
    return split ? _splitAtParagraphMarks(withMarkup) : withMarkup;
  };
  if (hasMarkup) {
    const rich = attempt(marked);
    if (rich === html) return html;
    // Verschachtelung nur prüfbar, wenn das Ausgangs-HTML selbst sauber ist.
    if (rich != null && _balanced(html) && _balanced(rich)) return rich;
  }
  const plain = attempt(paras);
  return plain == null ? html : plain;
}

/**
 * `skipReason` für `replaceInHtmlRich`: 'paragraphSplit', wenn nur die
 * Absatzteilung scheitert (die Stelle liegt nicht in einem schlichten Absatz),
 * sonst der Grund von `skipReason` für den Klartext.
 */
export function richSkipReason(html, needle, replacement) {
  const { paras, split } = parseRichReplacement(replacement);
  // Mit Absatzmarke statt Klartext prüfen: teilt der Ersatz nur, ohne ein Wort
  // zu ändern, wäre der Klartext-Ersatz ein No-Op ('unchanged').
  if (split && replaceInHtml(html, needle, paras.join(` ${PARA} `)) !== html) return 'paragraphSplit';
  return skipReason(html, needle, paras.join(' '));
}

// Fundstelle im Abschnittstext hervorheben (reines Lesen, keine DOM-Mutation):
// nach dem Sprung auf einen Abschnitt wird der Snippet im gerenderten
// `.page-content-view` gesucht und via CSS Custom Highlight API
// (::highlight(passage-hit), Muster wie Find/TTS) markiert + zentriert — damit
// landet ein Sprung in einen langen Abschnitt (ein ganzes Kapitel) an der
// Stelle statt an seinem Anfang. Findet die Passage nicht (semantischer Chunk
// quer über Blockgrenzen), wird auf das längste distinktive Wort
// zurückgefallen; findet auch das nichts, ruft es `onMiss` (der Aufrufer
// scrollt dann an den Abschnittsanfang). Einstieg für Konsumenten:
// app-navigation.js#gotoPageById(pageId, { snippet }).

import { scrollToWhenReady } from '../utils/scroll-when-ready.js';
import { notebookReadView } from '../editor/notebook/read-view.js';

const HL_NAME = 'passage-hit';
const MAX_PHRASE_WORDS = 12;
// Lange genug, um nach dem Sprung hinzusehen (auch wenn erst eine Karte
// zugeklappt wird); jeder Klick/Tipp irgendwo räumt die Markierung früher ab.
const HOLD_MS = 10000;

let _timer = null;
function _onPointer() { _clear(); }
function _clear() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  document.removeEventListener('pointerdown', _onPointer, true);
  try { window.CSS?.highlights?.delete(HL_NAME); } catch (_) { /* API evtl. nicht da */ }
}
function _hold() {
  _timer = setTimeout(_clear, HOLD_MS);
  // Capture: auch Klicks, deren Handler die Propagation stoppen, räumen ab.
  // Der auslösende Sprung-Klick liegt schon zurück — die Markierung entsteht
  // erst Frames später, nachdem der Abschnitt gerendert ist.
  document.addEventListener('pointerdown', _onPointer, true);
}
function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Range über die konkatenierten Text-Nodes bilden (whitespace-tolerant: die im
// Snippet enthaltenen Leerräume matchen \s+, weil der DOM-Text anders umbricht).
function _findRange(root, snippet) {
  const nodes = _textNodes(root);
  if (!nodes.length) return null;
  const starts = [];
  let acc = 0;
  const hay = nodes.map(n => { starts.push(acc); acc += n.nodeValue.length; return n.nodeValue; }).join('').toLowerCase();
  if (!hay.trim()) return null;

  const words = snippet.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return null;

  const tryRe = (src, flags = '') => { try { return new RegExp(src, flags).exec(hay); } catch (_) { return null; } };
  // Erst als ganzes Wort (ein Wortschatz-Term «see» soll nicht in «Seele»
  // landen), dann ohne Grenze (Snippet beginnt mitten im Wort, Flexion).
  const find = (src) => tryRe(`(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])`, 'u') || tryRe(src);
  // 1) Phrase (erste MAX_PHRASE_WORDS Wörter), Whitespace-tolerant.
  let m = find(words.slice(0, MAX_PHRASE_WORDS).map(_escapeRe).join('\\s+'));
  // 2) Fallback: längstes distinktives Wort (>=4 Zeichen).
  if (!m) {
    const word = words.filter(w => w.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (!word) return null;
    m = find(_escapeRe(word));
    if (!m) return null;
  }

  const gStart = m.index;
  const gEnd = m.index + m[0].length;
  const map = (g) => {
    for (let i = 0; i < nodes.length; i++) {
      const s = starts[i];
      const e = s + nodes[i].nodeValue.length;
      if (g >= s && g <= e) return { node: nodes[i], offset: g - s };
    }
    return null;
  };
  const a = map(gStart);
  const b = map(gEnd);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch (_) { return null; }
  return r;
}

// Snippets kommen teils als Markup (Suchtreffer mit <mark>) oder mit
// Auslassungszeichen am Rand — beides steht nicht im Abschnittstext.
function _plainSnippet(snippet) {
  return String(snippet || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    // Rand-Auslassung als «…» oder «...» (FTS-Snippet des Servers) — beidseitig.
    .replace(/^(?:[\s…]|\.{3})+|(?:[\s…]|\.{3})+$/g, '');
}

// Öffentlicher Einstieg: nach der Navigation aufgerufen. Wartet per rAF, bis
// der Zielabschnitt gerendert ist (bis ~60 Frames; mit `pageId` erst, wenn
// genau dieser offen ist — sonst suchte der erste Frame noch im vorigen
// Abschnitt), markiert dann + scrollt zentriert. Räumt die Markierung nach
// HOLD_MS oder beim nächsten Klick/Tipp irgendwo wieder ab. `onMiss`: keine
// Markierung möglich (Stelle nicht gefunden, Highlight-API fehlt) — der
// Aufrufer hat dann noch nicht gescrollt. `onHit`: Stelle markiert.
export function highlightOccurrenceOnPage(snippet, { pageId = null, onMiss = null, onHit = null } = {}) {
  _clear();
  const miss = () => { try { onMiss?.(); } catch (e) { console.error('[passage-highlight onMiss]', e); } };
  const text = _plainSnippet(snippet);
  if (!text || !window.CSS?.highlights || typeof window.Highlight === 'undefined') { miss(); return; }
  let tries = 0;
  const attempt = () => {
    const onTarget = pageId == null || String(window.__app?.currentPage?.id) === String(pageId);
    // Die Leseansicht, nicht das erste `.page-content-view` im Dokument — davor
    // stehen der (im Read-Modus leere) Edit-Container und der Revisions-Viewer.
    const root = onTarget ? notebookReadView() : null;
    if (root && root.textContent && root.textContent.trim()) {
      const r = _findRange(root, text);
      if (r) {
        try {
          window.CSS.highlights.set(HL_NAME, new window.Highlight(r));
          // Über den gemeinsamen Helfer: wartet eine zufahrende Tastatur ab
          // und verwirft einen noch wartenden älteren Sprung.
          const target = r.startContainer.parentElement || root;
          scrollToWhenReady(() => target);
          _hold();
        } catch (_) { /* Range/Highlight abgelaufen — egal */ }
        try { onHit?.(); } catch (e) { console.error('[passage-highlight onHit]', e); }
        return;
      }
    }
    if (tries++ < 60) requestAnimationFrame(attempt);
    else miss();
  };
  requestAnimationFrame(attempt);
}

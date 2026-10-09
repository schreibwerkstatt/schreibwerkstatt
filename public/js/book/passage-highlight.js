// Fundstelle im Abschnittstext hervorheben (reines Lesen, keine DOM-Mutation):
// nach dem Sprung auf einen Abschnitt wird der Snippet im gerenderten
// `.page-content-view` gesucht und via CSS Custom Highlight API
// (::highlight(passage-hit), Muster wie Find/TTS) markiert + zentriert — damit
// landet ein Sprung in einen langen Abschnitt (ein ganzes Kapitel) an der
// Stelle statt an seinem Anfang. Findet die Passage nicht (semantischer Chunk
// quer über Blockgrenzen), wird auf das längste distinktive Wort
// zurückgefallen; findet auch das nichts, passiert nichts (der Sprung auf den
// Abschnitt bleibt bestehen). Einstieg für Konsumenten:
// app-navigation.js#gotoPageById(pageId, { snippet }).

const HL_NAME = 'passage-hit';
const MAX_PHRASE_WORDS = 12;

function _clear() {
  try { window.CSS?.highlights?.delete(HL_NAME); } catch (_) { /* API evtl. nicht da */ }
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

  const tryRe = (re) => { try { return re.exec(hay); } catch (_) { return null; } };
  // 1) Phrase (erste MAX_PHRASE_WORDS Wörter), Whitespace-tolerant.
  let m = tryRe(new RegExp(words.slice(0, MAX_PHRASE_WORDS).map(_escapeRe).join('\\s+')));
  // 2) Fallback: längstes distinktives Wort (>=4 Zeichen).
  if (!m) {
    const word = words.filter(w => w.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (!word) return null;
    m = tryRe(new RegExp(_escapeRe(word)));
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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/^[\s…]+|[\s…]+$/g, '')
    .replace(/\.\.\.$/, '');
}

// Öffentlicher Einstieg: nach der Navigation aufgerufen. Wartet per rAF, bis
// der Zielabschnitt gerendert ist (bis ~60 Frames; mit `pageId` erst, wenn
// genau dieser offen ist — sonst suchte der erste Frame noch im vorigen
// Abschnitt), markiert dann + scrollt zentriert. Räumt die Markierung nach
// einigen Sekunden wieder ab.
export function highlightOccurrenceOnPage(snippet, { pageId = null } = {}) {
  _clear();
  const text = _plainSnippet(snippet);
  if (!text || !window.CSS?.highlights || typeof window.Highlight === 'undefined') return;
  let tries = 0;
  const attempt = () => {
    const onTarget = pageId == null || String(window.__app?.currentPage?.id) === String(pageId);
    const root = onTarget ? document.querySelector('.page-content-view') : null;
    if (root && root.textContent && root.textContent.trim()) {
      const r = _findRange(root, text);
      if (r) {
        try {
          window.CSS.highlights.set(HL_NAME, new window.Highlight(r));
          (r.startContainer.parentElement || root).scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(_clear, 4500);
        } catch (_) { /* Range/Highlight abgelaufen — egal */ }
        return;
      }
    }
    if (tries++ < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

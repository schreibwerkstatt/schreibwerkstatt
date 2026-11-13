// Gemeinsame Re-Anchor-Logik für Share-Kommentare (Reader-View + Owner-Vorschau).
// Eine verankerte Anmerkung haftet an einem Block via dessen data-bid +
// markiertem Quote-Text. Der Inhalt ist live (Autor editiert weiter), darum ist
// der Quote der Robustheits-Anker: Block per data-bid finden, Quote darin suchen
// (Offsets nur als Hinweis). Findet sich der Quote nicht, gibt locateRange null
// (Aufrufer markiert den Thread als „Stelle geändert").
//
// SSoT — wird von public/js/share-reader.js (Reader) und der Owner-Karte
// (public/js/cards/share-links-card.js, via share-anchor-preview) konsumiert.

// Zeichen-Offset eines (Container, Offset)-Punkts relativ zum Block-Textanfang.
export function charOffset(block, container, offset) {
  if (container.nodeType === Node.ELEMENT_NODE) {
    let total = 0;
    for (let i = 0; i < offset && i < container.childNodes.length; i++) {
      total += (container.childNodes[i].textContent || '').length;
    }
    const before = container === block ? 0 : textOffsetOf(block, container);
    return before + total;
  }
  return textOffsetOf(block, container) + offset;
}

export function textOffsetOf(block, node) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let total = 0, n;
  while ((n = walker.nextNode())) {
    if (n === node) return total;
    total += n.nodeValue.length;
  }
  return total;
}

export function rangeFromOffsets(block, start, end) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  const range = document.createRange();
  let total = 0, n, didStart = false, didEnd = false;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (!didStart && start <= total + len) { range.setStart(n, start - total); didStart = true; }
    if (!didEnd && end <= total + len) { range.setEnd(n, end - total); didEnd = true; break; }
    total += len;
  }
  return (didStart && didEnd) ? range : null;
}

// Status der gespeicherten Anmerkung gegen den aktuellen (live editierten) Text:
//   'match'   — Block da, Quote unverändert an den gespeicherten Offsets.
//   'moved'   — Block da, Quote wörtlich vorhanden, nur verschoben.
//   'changed' — Block da, Quote nicht mehr auffindbar → Text wurde geändert.
//               currentText = aktueller Block-Text um die alten Offsets (gekappt).
//   'gone'    — kein Block mit dieser data-bid in rootEl (gelöscht / andere Seite).
// Für 'changed' kann der Aufrufer Quote (damals) vs. currentText (jetzt) als
// Inline-Diff zeigen. anchor_quote ist serverseitig auf 600 Zeichen gekappt →
// der Diff ist quote-scoped, nicht ganzer Block.
export function resolveCurrentQuote(rootEl, anchor) {
  if (!rootEl || !anchor || !anchor.bid) return { status: 'gone', currentText: '' };
  let block;
  try { block = rootEl.querySelector(`[data-bid="${CSS.escape(anchor.bid)}"]`); } catch { block = null; }
  if (!block) return { status: 'gone', currentText: '' };
  const txt = block.textContent || '';
  const q = anchor.quote || '';
  const s = anchor.start, e = anchor.end;
  if (q && Number.isInteger(s) && Number.isInteger(e) && txt.slice(s, e) === q) {
    return { status: 'match', currentText: q };
  }
  if (q && txt.indexOf(q) >= 0) return { status: 'moved', currentText: q };
  let currentText = txt;
  if (Number.isInteger(s) && Number.isInteger(e) && e > s) {
    const pad = Math.max(8, Math.round((e - s) * 0.5));
    currentText = txt.slice(Math.max(0, s - pad), Math.min(txt.length, e + pad));
  }
  return { status: 'changed', currentText };
}

// Klick-Koordinaten → (Textknoten, Offset). Highlights (CSS Custom Highlight API)
// sind nicht klickbar — darum den Caret-Punkt unter dem Klick auflösen und ihn
// gegen die Kommentar-Ranges testen (range.isPointInRange(node, offset)). Zwei
// Browser-APIs: Standard (caretPositionFromPoint) zuerst, WebKit-Legacy
// (caretRangeFromPoint) als Fallback. SSoT für die Klick-→-Thread-Zuordnung in
// der Owner-Leiste (comment-rail-core) und der Share-Reader-Leiste.
export function caretPosFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

// Live-Range einer gespeicherten Anmerkung in `rootEl` finden (re-anchor by quote).
export function locateRange(rootEl, anchor) {
  if (!rootEl || !anchor || !anchor.bid) return null;
  let block;
  try { block = rootEl.querySelector(`[data-bid="${CSS.escape(anchor.bid)}"]`); } catch { block = null; }
  if (!block) return null;
  const txt = block.textContent;
  let s = anchor.start, e = anchor.end;
  const q = anchor.quote || '';
  if (!(Number.isInteger(s) && Number.isInteger(e) && txt.slice(s, e) === q)) {
    if (!q) return null;
    const idx = txt.indexOf(q);
    if (idx < 0) return null;
    s = idx; e = idx + q.length;
  }
  return rangeFromOffsets(block, s, e);
}

// Längster gemeinsamer Teilstring (zusammenhängend) von a und b. Liefert Länge +
// Startposition in beiden. Space-optimiertes DP (zwei Zeilen). O(|a|·|b|) — die
// Aufrufer begrenzen |b| auf ein Fenster um die alten Offsets.
function longestCommonSubstr(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return { len: 0, aPos: 0, bPos: 0 };
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  let best = 0, aEnd = 0, bEnd = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) { best = curr[j]; aEnd = i; bEnd = j; }
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev; prev = curr; curr = tmp; curr.fill(0);
  }
  return { len: best, aPos: aEnd - best, bPos: bEnd - best };
}

// Fuzzy-Anker: der Block (data-bid) existiert noch, aber der Quote ist nicht mehr
// wörtlich da (resolveCurrentQuote → 'changed'). Statt gar nichts zu markieren,
// den längsten überlebenden Quote-Fragment im Block finden und die Spanne um die
// ursprüngliche Quote-Länge nach links/rechts strecken → ungefährer Span. Die
// Suche ist auf ein Fenster um die alten Offsets begrenzt (begrenzt das DP +
// verhindert Treffer an einer zufällig gleichen Stelle weit weg). Gibt
// `{ range, approx: true }` oder null (zu wenig überlebt → Aufrufer markiert stale).
export function locateApprox(rootEl, anchor) {
  if (!rootEl || !anchor || !anchor.bid) return null;
  let block;
  try { block = rootEl.querySelector(`[data-bid="${CSS.escape(anchor.bid)}"]`); } catch { block = null; }
  if (!block) return null;
  const txt = block.textContent || '';
  const q = anchor.quote || '';
  if (!q || !txt) return null;

  const s = Number.isInteger(anchor.start) ? anchor.start : 0;
  const e = Number.isInteger(anchor.end) ? anchor.end : txt.length;
  const pad = Math.max(q.length, 40);
  const winStart = Math.max(0, Math.min(s, e) - pad);
  const winEnd = Math.min(txt.length, Math.max(s, e) + pad);
  const win = txt.slice(winStart, winEnd);

  const lcs = longestCommonSubstr(q, win);
  // Zu wenig zusammenhängender Text überlebt → kein verlässlicher Span.
  if (lcs.len < Math.max(4, Math.round(q.length * 0.25))) return null;

  // Überlebender Kern in txt; um den ursprünglich davor/danach stehenden
  // Quote-Anteil strecken (1:1-Annahme), auf Fenster + Block clampen.
  const coreStart = winStart + lcs.bPos;
  const coreEnd = coreStart + lcs.len;
  let start = Math.max(winStart, coreStart - lcs.aPos);
  let end = Math.min(winEnd, coreEnd + (q.length - (lcs.aPos + lcs.len)));
  start = Math.max(0, start);
  end = Math.min(txt.length, end);
  if (end <= start) return null;

  const range = rangeFromOffsets(block, start, end);
  return range ? { range, approx: true } : null;
}

// Anker-Objekt aus einer Kommentar-Zeile der API (`anchor_*`-Spalten).
export function anchorFromRow(row) {
  return { bid: row.anchor_bid, quote: row.anchor_quote, start: row.anchor_start, end: row.anchor_end };
}

// Anker-Y einer Kommentar-Karte relativ zur Layer-Oberkante (`layerTop`,
// viewport-px). Erst über die lokalisierte Range (Quote im Block gefunden);
// sonst — „Stelle geändert", Quote weg, Block noch da — über die Block-
// Oberkante; beides weg (Block gelöscht) → null. `skipRange`: Stelle ist
// bekanntermassen geändert, gleich die Block-Oberkante nehmen.
// Geteilt von Share-Reader-Leiste und beiden SPA-Leisten.
export function anchorYOf(rootEl, anchor, layerTop, { skipRange = false } = {}) {
  if (!anchor) return null;
  if (!skipRange) {
    const range = locateRange(rootEl, anchor);
    if (range) { const r = range.getBoundingClientRect(); if (r.height || r.width) return r.top - layerTop; }
  }
  if (anchor.bid) {
    let blk = null;
    try { blk = rootEl.querySelector(`[data-bid="${CSS.escape(String(anchor.bid))}"]`); } catch {}
    if (blk) return blk.getBoundingClientRect().top - layerTop;
  }
  return null;
}

// Fenster weich so scrollen, dass `range` `offset` px unter der Oberkante steht
// (Platz für Kopfleiste). Ohne messbare Höhe (Range kollabiert/abgehängt) nichts.
// Geteilt von Share-Reader (offset 120: schmale Leser-Kopfzeile) und den zwei
// SPA-Leisten (140: App-Kopf + Karten-Kopf).
export function scrollWindowToRange(range, offset) {
  const r = range?.getBoundingClientRect?.();
  if (!r || !r.height) return;
  window.scrollTo({ top: window.scrollY + r.top - offset, behavior: 'smooth' });
}

'use strict';
// Vertikale Verankerung der Anmerkungs-Karten in der Reader-Leiste
// (Google-Docs-Modell). Pendant zur Bucheditor-Leiste
// (public/js/editor/book-editor-comments.js) — hier standalone, ohne Alpine.
//
// Artikel und Kommentar-Spalte teilen denselben Scroll-Container (das Fenster)
// und beginnen in derselben Grid-Zeile auf gleicher Höhe. Der Abstand
// „Textstelle → Spalten-Oberkante" ist deshalb scroll-invariant — wir messen ihn
// nur bei Layout-Änderungen (Render, Resize, Edit-Reflow, Auswahl), NICHT bei
// jedem Scroll. Jede verankerte Karte schwebt auf der Höhe ihrer Textstelle;
// überlappende Karten werden greedy nach unten weggeschoben. Bei Auswahl wird die
// aktive Karte auf ihre exakte Anker-Höhe gepinnt, die übrigen darum herum gelegt.

import { locateRange } from '../share-anchor.js';
import { resolveCardPositions } from '../comment-card-layout.js';

const CARD_GAP = 10;
// Unter diesem Viewport fällt die Leiste auf eine statische Stapel-Liste zurück
// (siehe share.css ≥1100px-Branch) — das JS überspringt dann die Verankerung.
export const FLAT_BELOW = '(max-width: 1099px)';

// opts:
//   article()         → das Artikel-Element (#share-article)
//   getLayer()        → die Positionierungs-Ebene (.share-comments__list)
//   getAnchoredCards()→ [{ id, anchor }] der verankerten Root-Threads
//   getActiveId()     → aktuell fokussierter Thread (für Pin) oder null
export function createCardLayout(opts) {
  const { article, getLayer, getAnchoredCards, getActiveId } = opts;
  let raf = null;
  let ro = null;
  const observed = new Set();
  const supportsMM = typeof window !== 'undefined' && typeof window.matchMedia === 'function';

  function isFlat() { return supportsMM && window.matchMedia(FLAT_BELOW).matches; }

  function observe(el) {
    if (!el || !ro || observed.has(el)) return;
    try { ro.observe(el); observed.add(el); } catch {}
  }

  // Anker-Y einer Karte relativ zur Layer-Oberkante. Erst über die lokalisierte
  // Range (Quote im Block gefunden); sonst — „Stelle geändert", Quote weg, Block
  // noch da — über die Block-Oberkante. Beides weg (Block gelöscht) → null.
  function anchorY(card, view, layerTop) {
    const a = card.anchor;
    if (!a) return null;
    const range = locateRange(view, a);
    if (range) { const r = range.getBoundingClientRect(); if (r.height || r.width) return r.top - layerTop; }
    if (a.bid) {
      let blk = null;
      try { blk = view.querySelector(`[data-bid="${CSS.escape(String(a.bid))}"]`); } catch {}
      if (blk) return blk.getBoundingClientRect().top - layerTop;
    }
    return null;
  }

  function layout() {
    const layer = getLayer();
    const view = article();
    if (!layer || !view) return;

    // Flach-Modus (Mobile): inline-Positionen löschen, CSS stapelt statisch.
    if (isFlat()) {
      layer.style.removeProperty('--layer-height');
      for (const el of layer.querySelectorAll('.share-thread, .share-thread-marker')) {
        el.style.removeProperty('--comment-top');
        el.style.removeProperty('--marker-top');
      }
      return;
    }
    observe(view);

    const cards = getAnchoredCards();
    // Keine verankerten Karten → Höhe auf auto zurück (der Empty-Hinweis fliesst
    // normal, statt aus einer 0-px-Ebene zu ragen).
    if (!cards.length) { layer.style.removeProperty('--layer-height'); return; }
    const layerTop = layer.getBoundingClientRect().top;
    const activeId = getActiveId();

    // 1) Mess-Pass (nur Reads): Anker-Y + gemessene Kartenhöhe pro Thread. Das
    //    Schreiben der Marker ist bewusst in einen zweiten Pass getrennt — ein
    //    Marker-Write zwischen zwei getBoundingClientRect()-Reads würde sonst pro
    //    Karte einen Forced-Reflow erzwingen (Layout-Thrashing, O(n) Layouts bei n
    //    Karten). Karten ohne DOM-Element (noch nicht gerendert) fallen raus.
    const items = cards.map((c) => {
      const el = layer.querySelector(`.share-thread[data-comment-id="${CSS.escape(String(c.id))}"]`);
      const marker = layer.querySelector(`.share-thread-marker[data-marker-for="${CSS.escape(String(c.id))}"]`);
      observe(el);
      const y = anchorY(c, view, layerTop);
      return { id: c.id, el, marker, y, h: el ? el.offsetHeight : 0 };
    }).filter((it) => it.el);

    // 2) Marker-Write-Pass (nur Writes): Marker auf die echte Anker-Höhe setzen.
    for (const it of items) {
      if (!it.marker) continue;
      if (it.y == null) it.marker.style.removeProperty('--marker-top');
      else it.marker.style.setProperty('--marker-top', Math.round(it.y) + 'px');
    }

    // 3) Kollisions-Auflösung (Pin/greedy + Überlappungs-Sweep) im geteilten Kern
    //    (comment-card-layout.js, SSoT mit der Bucheditor-Leiste).
    const { tops, bottom } = resolveCardPositions({
      items: items.map(({ id, y, h }) => ({ id, y, h })),
      activeId,
      gap: CARD_GAP,
    });
    for (const it of items) it.el.style.setProperty('--comment-top', Math.round(tops.get(it.id)) + 'px');
    layer.style.setProperty('--layer-height', bottom + 'px');
    // Nach dem ersten Positionieren Karten einblenden (vorher unsichtbar, damit sie
    // nicht für 2 rAF-Frames auf top:0 aufblitzen). Positionswechsel sind hart, ohne
    // Scroll-Animation.
    layer.classList.add('is-positioned');
  }

  // Doppel-rAF: erstes wartet auf den DOM-Re-Render der Karten, zweites misst die
  // dann existierenden Höhen.
  function schedule() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => { raf = null; layout(); });
    });
  }

  function init() {
    if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => schedule());
    window.addEventListener('resize', schedule);
  }

  return { init, schedule, layout };
}

// Geteilte vertikale Verankerung der Kommentar-Karten (Google-Docs-Modell) für
// die zwei SPA-Kommentar-Leisten: Bucheditor (Scope = ganzer Stream) und
// Notebook-Leseansicht (Scope = einzelne Seite). Beide schweben jede verankerte
// Karte auf der Höhe ihrer Textstelle und scrollen mit dem Text im SELBEN
// Scroll-Container (Fenster) mit — der Abstand „Textstelle → Layer-Oberkante" ist
// dadurch scroll-invariant und wird nur bei Layout-Änderungen (Render, Resize,
// Edit, Auswahl) gemessen, nicht pro Scroll.
//
// Die Kollisions-Mathematik liegt pure in comment-card-layout.js (SSoT mit der
// Share-Reader-Leiste); hier bleibt die DOM-Glue: Anker-Y messen, Karten-Höhen
// per ResizeObserver beobachten, Doppel-rAF-Scheduling, Flach-Modus-Guard.
//
// `createCommentLayout(cfg)` liefert ein Methoden-Bündel (`_initCommentLayout`,
// `_scheduleCommentLayout`, `_layoutCommentCards`, …), das die Editor-Karten
// spreaden. Die Methodennamen sind bewusst editor-unabhängig — beide Editoren
// rufen sie gleich auf. Geometrie NIE im reaktiven State halten (Range-Objekte
// brechen als Alpine-Proxy); nur die numerischen `_anchorY`/`_railTop` landen
// reaktiv auf den Thread-Objekten.

import { anchorFromRow, anchorYOf } from '../share-anchor.js';
import { resolveCardPositions, createObservedSet } from '../comment-card-layout.js';

// Lückenabstand zwischen kollidierenden Karten (px).
const CARD_GAP = 10;

// cfg:
//   scopeEl()  → Element mit den data-bid-Blöcken (Stream bzw. Read-View)
//   layerEl()  → Positionierungs-Ebene (hält die absolut platzierten Karten)
//   flatBelow  → Media-Query-String; darunter Flach-Modus (statische Liste, kein Anchoring)
//   keys       → { threads, selectedRootId, railVisible, stackHeight }
export function createCommentLayout(cfg) {
  const K = cfg.keys;

  return {
    // Observer einrichten (aus Card-init). Re-Layout bei Stream-/Seiten-Reflow
    // (Edits, Font-Load) via ResizeObserver + bei Viewport-Resize.
    _initCommentLayout() {
      // Ein Observer für Scope UND Karten: Text-Reflow (Edits/Font) und
      // Karten-Höhenwachstum (async geladener „Stelle geändert"-Diff, aufgeklappte
      // Reply-Form) lösen beide ein Re-Layout aus. Loop-sicher, weil das Layout nur
      // `top` setzt, nie die Höhe der beobachteten Elemente.
      if (typeof ResizeObserver !== 'undefined') {
        this._commentResizeObs = new ResizeObserver(() => this._scheduleCommentLayout());
      }
      this._commentObserved = createObservedSet(this._commentResizeObs);
      this._commentResizeHandler = () => this._scheduleCommentLayout();
      window.addEventListener('resize', this._commentResizeHandler);
    },
    // Element einmalig beobachten (Set verhindert das Re-Fire bei erneutem observe).
    _observeForLayout(el) { this._commentObserved?.observe(el); },
    // Aus dem DOM gefallene Elemente (gelöschter/weggefilterter Thread, Buch-
    // oder Seitenwechsel) nicht weiter beobachten und nicht festhalten.
    _pruneObservedForLayout() { this._commentObserved?.prune(); },
    _teardownCommentLayout() {
      try { this._commentResizeObs?.disconnect(); } catch {}
      this._commentResizeObs = null;
      this._commentObserved = null;
      if (this._commentResizeHandler) window.removeEventListener('resize', this._commentResizeHandler);
      this._commentResizeHandler = null;
      if (this._commentLayoutRaf) { cancelAnimationFrame(this._commentLayoutRaf); this._commentLayoutRaf = null; }
    },

    _scheduleCommentLayout() {
      if (this._commentLayoutRaf) cancelAnimationFrame(this._commentLayoutRaf);
      // Doppel-rAF: erstes wartet auf Alpines x-for-Render der Threads, zweites
      // misst die dann existierenden Karten.
      this._commentLayoutRaf = requestAnimationFrame(() => {
        this._commentLayoutRaf = requestAnimationFrame(() => {
          this._commentLayoutRaf = null;
          this._layoutCommentCards();
        });
      });
    },

    // Anker-Y einer Karte relativ zur Layer-Oberkante. Verankerte Threads über die
    // lokalisierte Range; „Stelle geändert"-Threads (kein Range) über die
    // Block-Oberkante; sonst null.
    _commentAnchorY(thread, view, layerTop) {
      return anchorYOf(view, anchorFromRow(thread.root), layerTop, { skipRange: !!thread.changed });
    },

    _layoutCommentCards() {
      if (!this[K.railVisible]) return;
      // Flach-Modus (Mobile): Karten stapeln statisch, keine Verankerung.
      if (typeof window !== 'undefined' && window.matchMedia?.(cfg.flatBelow).matches) {
        this[K.stackHeight] = 0;
        for (const t of this[K.threads]) { t._anchorY = null; t._railTop = null; }
        return;
      }
      this._pruneObservedForLayout();
      const layer = cfg.layerEl();
      const view = cfg.scopeEl();
      if (!layer || !view) return;
      this._observeForLayout(view);

      const threads = this[K.threads];
      if (!threads.length) { this[K.stackHeight] = 0; return; }
      const layerTop = layer.getBoundingClientRect().top;

      // 1) Anker-Y + gemessene Kartenhöhe pro Thread; Marker auf echte Anker-Höhe.
      const items = threads.map((t) => {
        const y = this._commentAnchorY(t, view, layerTop);
        t._anchorY = y; // SSoT für Marker-Position (echte Stelle, vor Kollision)
        const el = layer.querySelector(`.comment-rail__thread[data-root-id="${CSS.escape(String(t.root.id))}"]`);
        this._observeForLayout(el);
        return { id: t.root.id, y, h: el ? el.offsetHeight : 0 };
      });

      // 2) Kollisions-Auflösung (Pin/greedy + Überlappungs-Sweep) im geteilten Kern.
      //    Tops zurück auf die reaktiven Thread-Felder spiegeln (treibt --comment-top).
      const { tops, bottom } = resolveCardPositions({ items, activeId: this[K.selectedRootId], gap: CARD_GAP });
      for (const t of threads) t._railTop = tops.get(t.root.id) ?? null;
      this[K.stackHeight] = bottom;
    },
  };
}

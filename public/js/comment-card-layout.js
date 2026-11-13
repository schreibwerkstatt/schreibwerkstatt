// Pure vertikale Verankerung der Kommentar-Karten (Google-Docs-Modell). SSoT für
// die Bucheditor-Leiste (public/js/editor/book-editor-comments.js, Alpine) und die
// Share-Reader-Leiste (public/js/share-reader/layout.js, vanilla). Beide messen
// ihre Karten selbst und übergeben { id, y, h }; diese Funktion löst die
// Kollisionen auf und liefert die Ziel-Tops + die Stapelhöhe. Keine DOM-/
// Framework-Abhängigkeit, damit die (fehleranfällige) Geometrie in Node
// unit-testbar bleibt und nicht zweimal driftet.
//
// Modell: jede Karte will auf der Höhe ihrer Textstelle schweben (`y`, relativ zur
// Layer-Oberkante). Überlappende Karten werden nach unten weggeschoben. Bei
// Auswahl wird die aktive Karte (`activeId`) auf ihre exakte Anker-Höhe gepinnt
// und die übrigen darum herum gelegt. Karten ohne lokalisierbare Stelle (`y == null`)
// hängen unten an.

const DEFAULT_GAP = 10;

// items:    [{ id, y, h }] — y = Anker-Höhe relativ zur Layer-Oberkante (px) oder
//                            null (Stelle nicht lokalisierbar), h = Kartenhöhe (px).
// activeId: gepinnte (selektierte) Karte oder null.
// gap:      Mindestabstand zwischen Karten (px).
// → { tops: Map<id, top>, bottom } — bottom = gerundete Stapelhöhe (Layer-Höhe).
export function resolveCardPositions({ items, activeId = null, gap = DEFAULT_GAP } = {}) {
  const list = Array.isArray(items) ? items : [];
  // Arbeits-Kopien (Eingabe bleibt unangetastet).
  const located = list.filter((it) => it.y != null).map((it) => ({ ...it })).sort((a, b) => a.y - b.y);
  const floating = list.filter((it) => it.y == null).map((it) => ({ ...it }));

  // 1) Kollisions-Auflösung → Wunsch-Tops. Bei Auswahl die aktive Karte auf ihre
  //    echte Höhe pinnen und die übrigen darum legen; sonst greedy top-down.
  const pin = activeId != null ? located.find((it) => it.id === activeId) : null;
  if (pin) {
    const pi = located.indexOf(pin);
    pin.top = Math.max(0, pin.y);
    let cur = pin.top + pin.h + gap;
    for (const it of located.slice(pi + 1)) { const top = Math.max(it.y, cur); it.top = top; cur = top + it.h + gap; }
    let curBottom = pin.top - gap;
    for (const it of located.slice(0, pi).reverse()) {
      let top = Math.min(it.y, curBottom - it.h);
      if (top < 0) top = 0;
      it.top = top; curBottom = top - gap;
    }
  } else {
    let cur = 0;
    for (const it of located) { const top = Math.max(it.y, cur); it.top = top; cur = top + it.h + gap; }
  }

  // 2) Finaler Vorwärts-Sweep über die Wunsch-Tops erzwingt Überlappungsfreiheit
  //    (der Pin-Aufwärtszweig kann bei zu wenig Platz oberhalb der gepinnten Karte
  //    mehrere Karten auf top:0 klemmen). Reicht der Platz → No-op.
  located.sort((a, b) => a.top - b.top);
  let prevBottom = -Infinity;
  for (const it of located) { const top = Math.max(it.top, prevBottom + gap, 0); it.top = top; prevBottom = top + it.h; }

  // 3) Nicht lokalisierbare (Block gelöscht) unten anhängen.
  let bottom = located.reduce((m, it) => Math.max(m, it.top + it.h), 0);
  for (const it of floating) { it.top = bottom + gap; bottom = it.top + it.h; }

  const tops = new Map();
  for (const it of [...located, ...floating]) tops.set(it.id, it.top);
  return { tops, bottom: Math.max(0, Math.round(bottom)) };
}

// Beobachtete Elemente eines ResizeObservers als Set führen: jedes Element nur
// einmal beobachten (erneutes observe() feuerte sonst sofort wieder) und aus
// dem DOM gefallene wieder freigeben (`prune`) — die Karten werden bei jedem
// Render neu gebaut, ohne Prune hielte das Set alle alten Knoten fest.
// Einzige DOM-nahe Ausnahme in dieser Datei, geteilt von allen drei Leisten.
export function createObservedSet(ro) {
  const set = new Set();
  return {
    observe(el) {
      if (!el || !ro || set.has(el)) return;
      try { ro.observe(el); set.add(el); } catch {}
    },
    prune() {
      for (const el of [...set]) {
        if (el.isConnected) continue;
        try { ro?.unobserve(el); } catch {}
        set.delete(el);
      }
    },
  };
}

// Alpine.store('badges') — buchweite Badge-Count-Maps (Sidebar-Indikatoren +
// Editor-/Kapitelansicht-Badges). Reine Daten-Maps ohne Verhalten, von vielen
// Modulen gelesen (tree.js, sidebar.html, kapitelreview.html, ideen.js,
// recherche.js, app-view/badges.js). Vorher flach in der Lektorat-God-State;
// jetzt eine schmale, benannte Store-Oberfläche. Der Store-Name liefert den
// Namespace, darum tragen die Keys kein `badges`-Präfix (Zugriff via
// `$store.badges.ideenCounts`).
//
// Kein Root-Proxy-Spiegel (wie nav/catalog/collab): Root-gespreadete Module
// (tree.js, app-view/badges.js, app-view/bookscope.js) greifen via
// `this.$store.badges.*` zu, die Templates via `$store.badges.*`, die per
// `window.__app`/Helper laufenden Module (ideen.js, recherche.js) via
// `Alpine.store('badges').*`.
//
// Schreibpfad ist immer Map-Reassignment (`store.x = nextMap`) — kein
// In-Place-Index-Assign, damit Alpine die Reaktivität feuert.
//
// Feld-Bedeutung (alle: Map id → count, plain Object):
//   ideenCounts            — page_id    → offene Ideen.
//   chapterIdeenCounts     — chapter_id → offene Ideen.
//   rechercheCounts        — page_id    → verknüpfte Recherche-Items.
//   chapterRechercheCounts — chapter_id → verknüpfte Recherche-Items.
//   plotBeatCounts         — page_id    → nicht-verworfene Plot-Beats des Kapitels.
//   chapterPlotBeatCounts  — chapter_id → nicht-verworfene Plot-Beats.
//   shareCommentCounts     — page_id    → offene Reviewer-Kommentare aus Share-Links.
//   shareLinkCounts        — page_id    → aktive Share-Links, die die Seite enthalten.
//
// Ausnahme vom Count-Schema, weil Baum, Organizer, Übersicht und Statistik sie
// teilen (docs/bearbeitungsstand.md):
//   editStatus             — page_id    → Bearbeitungsstand { status, stale, updated_by, … }.
//   editStatusChain        — Stufen-Kette des Buchs (Array, geordnet).
//
// Die abgeleiteten `currentPage*Count`-Skalare der offenen Seite bleiben am Root
// (pageState/lektoratState) — sie hängen an `currentPage`, nicht buchweit.

export function registerBadgesStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('badges', {
    ideenCounts: {},
    chapterIdeenCounts: {},
    rechercheCounts: {},
    chapterRechercheCounts: {},
    plotBeatCounts: {},
    chapterPlotBeatCounts: {},
    shareCommentCounts: {},
    shareLinkCounts: {},
    editStatus: {},
    editStatusChain: [],
  });
}

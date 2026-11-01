// Sprung zu einem Volltext-Treffer (GET /search). Einzige Implementierung für
// Suchkarte (search-card.js#activateHit) und Command-Palette (`?`-Provider in
// palette-providers.js) — beide zeigen dieselben Treffer und müssen gleich
// springen.

// Treffer-Art → Hash-Segment des Buch-Deep-Links (app-hash-router.js, Schema
// `#book/:bookId/<path>/:id`). `navId`: Figuren/Orte/Szenen adressiert der
// Router über ihre TEXT-ID, nicht über den INTEGER-PK.
export const CROSS_BOOK_SEGMENT = {
  page:     { path: 'page' },
  chapter:  { path: 'kapitel' },
  figure:   { path: 'figur', navId: true },
  location: { path: 'ort', navId: true },
  scene:    { path: 'szene', navId: true },
};

// Liefert den Deep-Link-Hash, wenn der Treffer aus einem anderen als dem
// gewählten Buch stammt (Scope «alle Bücher»), sonst null. Die Root-Methoden
// suchen nur im gewählten Buch und liefen ins Leere — der Hash wechselt das
// Buch, lädt es und öffnet dann das Ziel.
export function crossBookHash(hit, selectedBookId) {
  const seg = CROSS_BOOK_SEGMENT[hit?.kind];
  const hitBook = Number(hit?.book_id);
  if (!seg || !Number.isFinite(hitBook) || hitBook <= 0) return null;
  if (String(hitBook) === String(selectedBookId ?? '')) return null;
  const id = seg.navId ? (hit.nav_id ?? hit.entity_id) : hit.entity_id;
  return `#book/${hitBook}/${seg.path}/${encodeURIComponent(id)}`;
}

export async function activateSearchHit(root, hit) {
  if (!root || !hit) return;
  const nav = Alpine.store('nav');
  const crossHash = crossBookHash(hit, nav.selectedBookId);
  if (crossHash) {
    location.hash = crossHash;
    return;
  }
  switch (hit.kind) {
    case 'page':
      return root.gotoPageById?.(hit.entity_id, { snippet: hit.snippet });
    // Gleiches Ziel wie jede Kapitel-Referenz: Kapitelbewertung, ohne eine
    // solche der erste Abschnitt im Teilbaum.
    case 'chapter':
      return root.openChapterById?.(hit.entity_id);
    case 'book': {
      // FTS5 liefert book_id als String, selectedBookId ist numerisch →
      // sonst greift der strikte Vergleich nie und reassignt bei jedem
      // Treffer einen String.
      const bid = Number(hit.book_id);
      if (Number.isFinite(bid) && nav.selectedBookId !== bid) nav.selectedBookId = bid;
      root.toggleBookOverviewCard?.();
      return;
    }
    // `nav_id`, nicht `entity_id`: Figuren/Schauplaetze werden ueber ihre
    // TEXT-ID adressiert (fig_id/loc_id), Index + Embedding-Chunks fuehren
    // den INTEGER-PK. Mit dem PK oeffnet die Karte zwar (und die URL sieht
    // richtig aus), die Zeile klappt aber nie auf.
    case 'figure':
      return root.openFigurById?.(hit.nav_id ?? hit.entity_id);
    case 'location':
      return root.openOrtById?.(hit.nav_id ?? hit.entity_id);
    case 'scene':
      return root.openSzeneById?.(hit.nav_id ?? hit.entity_id);
    case 'fact': {
      // Welt-Fakten haben keine Einzel-Ansicht: der Treffer oeffnet die
      // Welt-Fakten-Karte des Buches (Hash-Router #book/:id/fakten).
      const bid = Number(hit.book_id) || nav.selectedBookId;
      if (!bid) return;
      location.hash = `#book/${bid}/fakten`;
      return;
    }
    case 'research': {
      // Deep-Link-Hash als SSoT (analog reference-card#openRechercheItem):
      // der Hash-Router oeffnet die Karte, setzt Exklusivitaet und
      // fokussiert das Item.
      const bid = Number(hit.book_id) || nav.selectedBookId;
      if (!bid) return;
      location.hash = `#book/${bid}/recherche/${hit.entity_id}`;
      return;
    }
    case 'idea': {
      // Der Index fuehrt zur Idee weder Abschnitt noch Kapitel — das
      // Ideen-Board zeigt jede Idee (auch Buch-Ideen). Fremdes Buch: per
      // Hash, der wechselt das Buch mit.
      const bid = Number(hit.book_id);
      if (Number.isFinite(bid) && bid > 0 && String(bid) !== String(nav.selectedBookId ?? '')) {
        location.hash = `#book/${bid}/ideen`;
        return;
      }
      // Kein Toggle auf die offene Karte — der zweite Aufruf schloesse sie.
      if (!root.showIdeenBoardCard) return root.toggleIdeenBoardCard?.();
      root._scrollToCardByKey?.('ideenBoard');
      return;
    }
  }
}

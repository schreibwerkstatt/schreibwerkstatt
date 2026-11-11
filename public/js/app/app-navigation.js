import { EVT } from '../events.js';
import { highlightOccurrenceOnPage } from '../book/passage-highlight.js';
import { openCardWith, CARD_REQUEST } from '../cards/card-request.js';
import { firstPageInChapter } from '../book/tree/first-page.js';
import { scrollToWhenReady } from '../utils/scroll-when-ready.js';

// Figuren/Orte/Szenen-IDs sind INTEGER-PKs; aus Volltext-Treffern (FTS5
// liefert entity_id als String) und aus Deep-Link-Hashes kommen sie als
// String. Der Listen-Expand vergleicht strikt (`selectedFigurId === f.id`,
// f.id = Number), darum hier auf Number normalisieren — sonst scrollt die
// Liste zwar (data-attr ist String), klappt das Element aber nie auf.
function _coerceId(id) {
  return (typeof id === 'string' && /^\d+$/.test(id)) ? Number(id) : id;
}


// Interne Navigation zwischen Buch-Views. `_beginNavigation/_endNavigation`
// klammern zusammengesetzte Karten-Öffnungen (z.B. openFigurById →
// toggleFiguresCard → scrollIntoView), damit der Hash-Router nur EINEN
// History-Eintrag pro logischer Navigation schreibt statt pro Zwischenschritt.
export const appNavigationMethods = {
  async openFigurById(figId) {
    return this._openFigurInListe(figId, '');
  },

  // Kapitel per ID (chapter-filter.js): gleichnamige Kapitel sind zwei Kapitel.
  async openFigurMitKapitel(figId, chapterId) {
    return this._openFigurInListe(figId, chapterId ?? '');
  },

  // Figur in der Liste aufklappen und hinscrollen. Die Liste ist ein Reiter der
  // Karte: der Sprung (Verweis, Palette, Graph-Knoten, Hash) muss ihn erst
  // anwählen, sonst klappt die Zeile in einer ausgeblendeten Liste auf.
  async _openFigurInListe(figId, kapitelId) {
    this._beginNavigation();
    try {
      const fid = _coerceId(figId);
      // Alle Filter zuruecksetzen wie bei Ort/Szene/Ereignis: eine stehende
      // Suche oder ein Typ-Filter schneidet die Zielfigur aus `filteredFiguren()`,
      // die Zeile wird nie gerendert und der Sprung endet sichtbar im Nichts.
      // Die Sortierung bleibt — sie blendet nichts aus.
      const filters = this.$store.catalogUi.figurenFilters;
      filters.suche = '';
      filters.typ = '';
      filters.kapitelId = kapitelId;
      filters.seiteId = '';
      await openCardWith(CARD_REQUEST.FIGUREN_TAB, 'liste',
        () => (this.showFiguresCard ? null : this.toggleFiguresCard({ skipCardScroll: true })));
      this.$store.catalogUi.selectedFigurId = fid;
      await this.$nextTick();
      // Nur eine sichtbare Zeile: bis der Reiterwechsel gerendert ist, steht die
      // Zeile in der ausgeblendeten Liste (offsetParent null, Position 0).
      scrollToWhenReady(() => {
        const el = document.querySelector(`[data-figid="${fid}"]`);
        return el?.offsetParent ? el : null;
      });
    } finally {
      this._endNavigation();
    }
  },

  async openOrtById(ortId) {
    this._beginNavigation();
    try {
      const oid = _coerceId(ortId);
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitelId = '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard({ skipCardScroll: true });
      }
      this.$store.catalogUi.selectedOrtId = oid;
      await this.$nextTick();
      scrollToWhenReady(`[data-ortid="${oid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openOrtMitKapitel(ortId, chapterId) {
    this._beginNavigation();
    try {
      const oid = _coerceId(ortId);
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitelId = chapterId ?? '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard({ skipCardScroll: true });
      }
      this.$store.catalogUi.selectedOrtId = oid;
      await this.$nextTick();
      scrollToWhenReady(`[data-ortid="${oid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openWerkstattDraftById(draftId) {
    this._beginNavigation();
    try {
      if (!this.showFigurWerkstattCard) {
        await this.toggleFigurWerkstattCard();
      }
      // Sub übernimmt Draft-Wechsel via figur-werkstatt:select. Drafts evtl.
      // noch nicht geladen → Sub parkt _pendingDraftId und löst nach loadDrafts.
      window.dispatchEvent(new CustomEvent(EVT.FIGUR_WERKSTATT_SELECT, {
        detail: { draftId },
      }));
      this.$store.nav.werkstattDraftId = draftId;
    } finally {
      this._endNavigation();
    }
  },

  // Cross-Feature: aus dem Plot-Board (Beat-Motiv-Badge) in die Motiv-Werkstatt
  // springen und dort das Motiv auswählen. Die Motiv-Karte hört `motiv:select`
  // und parkt die ID, falls das Board noch nicht geladen ist.
  async openMotifById(motifId) {
    this._beginNavigation();
    try {
      const mid = _coerceId(motifId);
      if (!this.showMotivCard) {
        await this.toggleMotivCard();
      }
      window.dispatchEvent(new CustomEvent(EVT.MOTIV_SELECT, {
        detail: { motifId: mid },
      }));
    } finally {
      this._endNavigation();
    }
  },

  // Cross-Feature: aus der Figuren-Werkstatt ins Plot-Board springen, gefiltert auf
  // die Beats dieser Werkstatt-Figur. Die Plot-Karte hört `plot:filter-draft-figure`
  // und parkt das Ziel, falls das Board noch nicht geladen ist.
  async openPlotForDraftFigure(draftId) {
    this._beginNavigation();
    try {
      if (!this.showPlotCard) {
        await this.togglePlotCard();
      }
      window.dispatchEvent(new CustomEvent(EVT.PLOT_FILTER_DRAFT_FIGURE, {
        detail: { draftId },
      }));
    } finally {
      this._endNavigation();
    }
  },

  async openSzeneById(szeneId) {
    this._beginNavigation();
    try {
      const sid = _coerceId(szeneId);
      this.$store.catalogUi.szenenFilters.suche = '';
      this.$store.catalogUi.szenenFilters.wertung = '';
      this.$store.catalogUi.szenenFilters.figurId = '';
      this.$store.catalogUi.szenenFilters.kapitelId = '';
      this.$store.catalogUi.szenenFilters.seiteId = '';
      this.$store.catalogUi.szenenFilters.ortId = '';
      if (!this.showSzenenCard) {
        await this.toggleSzenenCard({ skipCardScroll: true });
      }
      this.$store.catalogUi.selectedSzeneId = sid;
      await this.$nextTick();
      scrollToWhenReady(`[data-szeneid="${sid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  // Ereignis-Filter setzen: erst ALLE fuenf nullen, dann `patch` anwenden.
  // Ein Einstieg in die Ereignisse-Karte kommt immer mit einer Absicht („dieses
  // Ereignis", „dieses Kapitel", „diese Figur") — ein stehender Filter aus einem
  // frueheren Besuch schneidet das Ziel aus `filteredEreignisse()`, die Zeile
  // wird nie gerendert und der Sprung endet sichtbar im Nichts. Genau darum ist
  // das ein Helper und keine Liste von Zuweisungen je Einstieg: die drei
  // Einstiege hatten drei verschiedene Teilmengen genullt.
  _setEreignisseFilter(patch = {}) {
    const f = this.$store.catalogUi.ereignisseFilters;
    f.figurId = ''; f.kapitelId = ''; f.seiteId = ''; f.subtyp = ''; f.suche = '';
    Object.assign(f, patch);
  },

  // Einzelnes Ereignis oeffnen (Palette-Treffer, Deep-Link `#…/ereignis/<id>`).
  async openEreignisById(ereignisId) {
    this._beginNavigation();
    try {
      const eid = _coerceId(ereignisId);
      this._setEreignisseFilter();
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard({ skipCardScroll: true });
      }
      this.$store.catalogUi.selectedEreignisId = eid;
      await this.$nextTick();
      scrollToWhenReady(`[data-event-id="${eid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitKapitel(chapterId) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this._setEreignisseFilter({ kapitelId: chapterId ?? '' });
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitFigur(figurId) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this._setEreignisseFilter({ figurId });
    } finally {
      this._endNavigation();
    }
  },

  // Löst Kapitel+Seite (Namen) zu einem Page-Objekt auf. Mehrdeutigkeit in
  // dieser Reihenfolge: Kapitel exakt → exakte Seite → Teilstring-Seite →
  // erste Kapitelseite; ohne Kapitel: globaler Seiten-Fallback.
  _resolvePage(kapitel, seite) {
    const kName = Array.isArray(kapitel) ? kapitel[0] : kapitel;
    if (!kName && !seite) return null;
    const chapters = (this.$store.nav.tree || []).filter(t => t.type === 'chapter' && !t.solo);
    const sLower = seite ? String(seite).toLowerCase() : '';
    if (!kName) {
      return this.$store.nav.pages.find(p => p.name === seite)
        || this.$store.nav.pages.find(p => p.name.toLowerCase() === sLower)
        || null;
    }
    const chapter = chapters.find(c => c.name === kName);
    const pages = chapter?.pages || [];
    if (!pages.length) return null;
    if (seite) {
      const exact = pages.find(p => p.name === seite)
        || pages.find(p => p.name.toLowerCase() === sLower);
      if (exact) return exact;
      const sub = pages.find(p => {
        const n = p.name.toLowerCase();
        return n && (n.includes(sLower) || sLower.includes(n));
      });
      if (sub) return sub;
    }
    return pages[0];
  },

  gotoStelle(kapitel, seite) {
    const page = this._resolvePage(kapitel, seite);
    if (page) this.selectPage(page);
  },

  // `snippet`: Textstelle, an die gesprungen wird (Fundstellen aus Suche,
  // Motiven, Figurenbogen, Plot, Buchlandkarte) — sonst landete der Sprung in
  // einem langen Abschnitt immer an dessen Anfang. Markierung + Scroll in
  // book/passage-highlight.js; ohne Treffer bleibt es beim Abschnittsanfang.
  async gotoPageById(pageId, { snippet = '' } = {}) {
    if (!pageId) return;
    const page = this.$store.nav.pages.find(p => String(p.id) === String(pageId));
    if (!page) return;
    // Mit Fundstelle scrollt nur die Markierung (zur Textstelle, die Karte
    // kommt dabei mit ins Bild); findet sie die Stelle nicht, springt sie
    // ersatzweise an den Anfang des Abschnitts — aber nur, solange der User
    // seit dem Sprung nichts selbst getan hat: der Fehlschlag steht erst nach
    // den Ladeschritten von selectPage fest (Sekunden), und ein Hochscrollen
    // dann risse ihn aus dem Text, den er inzwischen liest.
    let userMoved = false;
    const onUser = () => { userMoved = true; };
    const USER_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
    if (snippet) for (const t of USER_EVENTS) window.addEventListener(t, onUser, { capture: true, passive: true });
    const stopWatch = () => { for (const t of USER_EVENTS) window.removeEventListener(t, onUser, { capture: true }); };
    try {
      await this.selectPage(page, { skipCardScroll: !!snippet });
    } catch (e) { stopWatch(); throw e; }
    if (snippet && String(this.currentPage?.id) === String(page.id)) {
      highlightOccurrenceOnPage(snippet, {
        pageId: page.id,
        onHit: stopWatch,
        onMiss: () => { stopWatch(); if (!userMoved) this._scrollToEditorCard(); },
      });
    } else stopWatch();
  },

  // Erster Abschnitt im Teilbaum: ein Kapitel, das nur Unterkapitel trägt,
  // springt in deren ersten Abschnitt statt ins Leere.
  gotoChapterById(chapterId) {
    if (!chapterId) return;
    const first = firstPageInChapter(this.$store.nav.tree, chapterId);
    if (first) this.selectPage(first);
  },

  // Zusammengesetzte Navigationen (z.B. openFigurById → toggleFiguresCard
  // → loadFiguren) erzeugen sonst mehrere History-Einträge. Mit diesem
  // Wrapper werden Zwischen-States unterdrückt, am Ende genau einmal gepusht.
  // Inside _applyHash: unterdrückt alles, URL wird nicht angefasst (Hash
  // hat bereits den Zielzustand vorgegeben).
  _beginNavigation() {
    this._navDepth += 1;
    this._applyingHash = true;
  },
  _endNavigation() {
    this._navDepth = Math.max(0, this._navDepth - 1);
    if (this._navDepth > 0) return;
    if (this._inHashApply) return;
    this._applyingHash = false;
    this._writeHash(this._computeHash());
  },
};

// Persistenter Collapse-State des Sidebar-Trees pro (User, Buch) + Chapter-Header-
// Aktivierung. `this` = die Alpine-Komponente.

export const treeOpenStateMethods = {
  async _onChapterHeaderActivate(item) {
    // Waehrend Suche/Stand-Filter ist `item` eine Kopie und alles offen: das
    // Kapitel oeffnet dort weiter seine Bewertung bzw. die Anlage des ersten
    // Abschnitts, nur das Auf-/Zuklappen entfaellt.
    const filtered = this._treeIsFiltered();
    // Leeres Kapitel → kapitel-review-card öffnen, damit User direkt eine
    // erste Seite anlegen kann. openKapitelReviewForChapter filtert 0-Seiten-
    // Kapitel via kapitelReviewChapterOptions() raus, deswegen direkt setzen.
    // chapterId zuerst am Root setzen, dann toggle awaiten — toggle lädt das
    // Partial via `_ensurePartial`; ohne await bleibt die Karte leer.
    if (item.pages.length === 0 && !item.hasChildren) {
      // Buch aus lauter Ein-Abschnitt-Kapiteln: der erste Abschnitt entsteht
      // gleichnamig und oeffnet sich — eine Namensabfrage liesse Kapitel- und
      // Abschnittsname auseinanderlaufen (tree/structure.js#_createFirstSection).
      if (this.canEdit() && this._bookUsesSingleSectionChapters()) {
        await this._createFirstSection(item);
        return;
      }
      this.kapitelReviewChapterId = String(item.id);
      if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
      else this._closeOtherMainCards('kapitelReview');
      return;
    }
    // Parent-Kapitel ohne direkte Pages, aber mit Sub-Kapiteln, öffnen das
    // Review (include_subchapters greift dann automatisch, siehe kapitelReviewIncludeSubchapters).
    if (this._bookQualifiesForChapterReview()) await this.openKapitelReviewForChapter(item.id);
    else if (!filtered) this.toggleChapterOpen(item);
  },

  // Ob die Abschnittszeilen eines Baum-Eintrags gerendert werden. Zugeklappte
  // Kapitel rendern sie gar nicht (nicht nur per x-show versteckt): bei
  // Buechern mit tausenden Abschnitten waeren das zehntausende DOM-Knoten samt
  // reaktiver Bindings, die niemand sieht. SSoT fuer sidebar.html und den
  // Tab-Stopp (keyboard.js#_syncTreeTabStop).
  _chapterPagesShown(item) {
    return !!(item.solo || item.open || this._isSingleSectionChapter(item));
  },

  // Persistenter Collapse-State des Sidebar-Trees pro (User, Buch). Default
  // ohne gespeicherten State: offen, ab TREE_COLLAPSE_MIN_PAGES Abschnitten
  // zu (book/tree/build.js) — das Kapitel der geoeffneten Seite deckt
  // _revealPageInTree auf. Solo-Items werden nicht persistiert — sie sind
  // reine Page-Wrapper ohne Toggle.
  _treeOpenStorageKey(bookId) {
    if (!bookId) return '';
    return `sw:treeOpen:${this.$store.session.currentUser?.email || ''}:${bookId}`;
  },
  _loadTreeOpenState(bookId) {
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return {};
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  },
  _persistTreeOpenState() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return;
      const state = {};
      for (const item of this.$store.nav.tree) {
        if (item.type === 'chapter' && !item.solo) state[item.id] = !!item.open;
      }
      localStorage.setItem(key, JSON.stringify(state));
    } catch { /* quota / disabled storage — ignore */ }
  },
  // Immer am Original in nav.tree: aus dem Template kann eine Such-/Filter-Kopie
  // kommen, deren `open` weder persistiert noch den naechsten Render ueberlebt.
  // Bei aktivem Filter ist alles offen — Toggles bleiben dort wirkungslos.
  setChapterOpen(item, value) {
    if (!item || item.solo || this._treeIsFiltered()) return;
    const orig = this._findTreeChapter(item.id) || item;
    orig.open = !!value;
    this._persistTreeOpenState();
  },
  toggleChapterOpen(item) {
    if (!item || item.solo) return;
    const orig = this._findTreeChapter(item.id) || item;
    this.setChapterOpen(orig, !orig.open);
  },
  setAllChaptersOpen(value) {
    if (this._treeIsFiltered()) return;
    for (const item of this.$store.nav.tree) {
      if (item.type === 'chapter' && !item.solo) item.open = !!value;
    }
    this._persistTreeOpenState();
  },
};

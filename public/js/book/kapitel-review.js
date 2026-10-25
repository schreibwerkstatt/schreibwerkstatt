// Root-seitige Einstiegspunkte für die Kapitel-Bewertung (Sidebar + Hash-Router).
// Job-Flow, Render, State + History leben in Alpine.data('kapitelReviewCard').

// Stabiler Leerwert fuer den Memo-Schluessel (ein frisches `{}` je Aufruf brach ihn).
const NO_STATS = Object.freeze({});

export const kapitelReviewMethods = {
  async toggleKapitelReviewCard() {
    if (this.showKapitelReviewCard) {
      this.showKapitelReviewCard = false;
      // Kapitel-Ideen-Karte lebt neben der Kapitelreview-Karte und schliesst
      // gemeinsam mit ihr.
      if (this.ideenScope === 'chapter' && this.showIdeenCard) {
        this.showIdeenCard = false;
      }
      return;
    }
    this._closeOtherMainCards('kapitelReview');
    await this._ensurePartial('kapitelreview');
    this.showKapitelReviewCard = true;
    this._scrollToCardByKey('kapitelReview');
  },

  async openKapitelReviewForChapter(chapterId) {
    if (!chapterId) return;
    const opts = this.kapitelReviewChapterOptions();
    if (!opts.some(c => String(c.id) === String(chapterId))) return;
    // chapterId am Root-SSoT zuerst setzen, dann toggle awaiten — vor dem
    // Partial-Load gibt es keinen Listener für ein `kapitel-review:select`-Event.
    this.kapitelReviewChapterId = String(chapterId);
    if (!this.showKapitelReviewCard) {
      await this.toggleKapitelReviewCard();
    }
  },

  // Sprungziel jeder Kapitel-Referenz (x-entity-ref, Hash-Router-Fallback):
  // die Kapitelbewertung. Nur wo das Kapitel keine hat (leer, Solo-Abschnitt),
  // führt der Sprung auf den ersten Kapitelabschnitt — sonst endete der Klick im
  // Nichts.
  async openChapterById(chapterId) {
    if (chapterId == null || chapterId === '') return;
    const opts = this.kapitelReviewChapterOptions();
    if (opts.some(c => String(c.id) === String(chapterId))) {
      await this.openKapitelReviewForChapter(chapterId);
      return;
    }
    this.gotoChapterById(chapterId);
  },

  // Kapitel per Name (Analyse-Listen speichern Namen, keine IDs). Match per
  // exaktem Namen, dann case-insensitive; ohne Treffer der Seiten-Fallback.
  async openKapitelByName(name) {
    if (!name) return;
    const chapters = (this.$store.nav.tree || []).filter(i => i.type === 'chapter' && !i.solo);
    const lc = String(name).toLowerCase();
    const ch = chapters.find(c => c.name === name)
      || chapters.find(c => c.name.toLowerCase() === lc);
    if (ch) { await this.openChapterById(ch.id); return; }
    this.gotoStelle(name, null);
  },

  // Jedes Buch mit mindestens einem Kapitel, das Text traegt (eigene Abschnitte
  // oder Unterkapitel), hat eine Kapitelbewertung — auch wenn jedes Kapitel aus
  // genau einem Abschnitt besteht: die Bewertung (Achsen, Belege, Dashboard) ist
  // eine andere Linse als das Abschnitts-Lektorat, nicht dessen Duplikat. Nur
  // Buecher aus reinen Solo-Abschnitten haben keine Kapiteleinheit.
  // Memoisiert: sidebar.html liest das Praedikat ZWEIMAL pro Kapitelzeile
  // (`:class` + `:data-tip`), obwohl es eine Aussage ueber das ganze Buch ist —
  // ungecacht ist ein Sidebar-Render O(Kapitel x Baumlaenge), und jede Zeile
  // haengt reaktiv am gesamten Baum, sodass jede Baum-Mutation alle Zeilen
  // invalidiert. Deps sind bewusst nur O(1)-Groessen (sonst kostet der
  // Cache-Schluessel genau den Durchlauf, den er spart): Baum-Referenz +
  // Kapitelzahl decken Anlegen/Loeschen/Neuladen ab, die Referenz der flachen
  // Seitenliste plus ihre Laenge das Anlegen/Loeschen/Verschieben von Seiten,
  // die Baum-Revision (tree/build.js#_bumpTreeRev) die In-Place-Umbauten
  // (hasChildren, Verschachtelung), `tokEsts` den Text.
  //
  // Massgeblich ist ein Abschnitt MIT Text in irgendeinem Kapitel (Unterkapitel
  // sind selbst Kapitel-Items im flachen Baum) — ein Teil, dessen ganzer
  // Unterbaum leer ist, hat nichts zu bewerten. Unbekannter Umfang (Stats laden
  // noch) zaehlt als Text, sonst flackerte der Zugang bei jedem Buchwechsel.
  _bookQualifiesForChapterReview() {
    const tree = this.$store.nav.tree || [];
    const pages = this.$store.nav.pages || [];
    const ts = this.tokEsts || NO_STATS;
    const rev = this._treeRev;
    const memo = this._chapterReviewEligibleMemo;
    if (memo && memo.tree === tree && memo.treeLen === tree.length && memo.rev === rev
        && memo.pages === pages && memo.pagesLen === pages.length && memo.ts === ts) return memo.val;
    const hasText = (p) => { const e = ts[p.id]; return !e || e.chars > 0; };
    const val = tree.some(i => i.type === 'chapter' && !i.solo && (i.pages || []).some(hasText));
    this._chapterReviewEligibleMemo = {
      tree, treeLen: tree.length, rev, pages, pagesLen: pages.length, ts, val,
    };
    return val;
  },

  kapitelReviewChapterOptions() {
    if (!this._bookQualifiesForChapterReview()) return [];
    const tree = this.$store.nav.tree || [];
    const hasSub = (id) => tree.some(i =>
      i.type === 'chapter' && !i.solo && String(i.parent_id) === String(id)
    );
    return tree
      .filter(i => i.type === 'chapter' && !i.solo && (i.pages.length > 0 || hasSub(i.id)))
      .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
  },
};

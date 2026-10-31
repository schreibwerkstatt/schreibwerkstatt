// Teil von appViewMethods (siehe Facade app-view.js).
import { fetchJson } from './_shared.js';
import { isOpenIdee } from '../../book/ideen-shared.js';

export const badgesMethods = {

  // Lädt Badge-Counts (offene Ideen, Chat-Sessions) für die geöffnete Seite.
  // Race-safe: prüft pageId gegen aktuelle Seite vor Set, falls User schnell wechselt.
  async _loadPageBadgeCounts(pageId) {
    try {
      // Fehler (Netz/5xx) → null statt []: sonst zeigte die Plakette „0 offene
      // Ideen" und der Tree-Indikator verlöre seinen Punkt. Bei null bleibt der
      // bisherige Stand stehen.
      const [ideen, sessions] = await Promise.all([
        fetchJson(`/ideen?page_id=${pageId}`).catch(() => null),
        fetchJson(`/chat/sessions/${pageId}`).catch(() => null),
      ]);
      if (this.currentPage?.id !== pageId) return;
      // Recherche-Count aus der buchweit geladenen Map (kein Extra-Request);
      // wird bei Link-Änderungen in der Recherche-Karte frisch gehalten.
      const badges = this.$store.badges;
      this.currentPageRechercheCount = (badges.rechercheCounts || {})[pageId] || 0;
      // Plot-Beat-Count ebenfalls aus der buchweit geladenen Map (kein Extra-Request).
      this.currentPagePlotBeatCount = (badges.plotBeatCounts || {})[pageId] || 0;
      this.currentPageShareCommentCount = (badges.shareCommentCounts || {})[pageId] || 0;
      this.currentPageShareLinkCount = (badges.shareLinkCounts || {})[pageId] || 0;
      if (Array.isArray(sessions)) this.currentPageChatSessionCount = sessions.length;
      if (Array.isArray(ideen)) {
        // „Offen" = offen ODER in_arbeit (SSoT ideen-shared.js). Eine verworfene
        // Idee ist keine offene Pendenz und setzt darum keine Plakette.
        const openCount = ideen.filter(isOpenIdee).length;
        this.currentPageIdeenOpenCount = openCount;
        // Tree-Indikator mit frischer Wahrheit syncen (z.B. bei Cross-Tab-Edits).
        const next = { ...(badges.ideenCounts || {}) };
        if (openCount > 0) next[pageId] = openCount;
        else delete next[pageId];
        badges.ideenCounts = next;
      }
    } catch (e) {
      console.error('[loadPageBadgeCounts]', e);
    }
  },


  // Pro-Seite-Map offener Reviewer-Kommentare neu laden (nach Resolve/Delete in
  // der Share-Karte) und den Badge der offenen Seite syncen.
  async refreshShareCommentCounts() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/share/api/page-comment-counts?book_id=${bookId}`).catch(() => null);
      if (!map || this.$store.nav.selectedBookId !== bookId) return;
      this.$store.badges.shareCommentCounts = map;
      if (this.currentPage?.id) this.currentPageShareCommentCount = map[this.currentPage.id] || 0;
    } catch (e) {
      console.error('[refreshShareCommentCounts]', e);
    }
  },


  // Page- + Chapter-Map verknüpfter Plot-Beats neu laden (nach Kapitel-/Verwerfen-/
  // Lösch-Änderung in der Plot-Karte) und den Editor-Badge der offenen Seite
  // syncen. Beats hängen am Kapitel → Page-Count ist kapitelweit projiziert,
  // die Kapitelansicht liest chapterPlotBeatCounts direkt.
  async refreshPlotBeatCounts() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const [pageMap, chapterMap] = await Promise.all([
        fetchJson(`/plot/page-beat-counts?book_id=${bookId}`).catch(() => null),
        fetchJson(`/plot/chapter-beat-counts?book_id=${bookId}`).catch(() => null),
      ]);
      if (this.$store.nav.selectedBookId !== bookId) return;
      if (pageMap) {
        this.$store.badges.plotBeatCounts = pageMap;
        if (this.currentPage?.id) this.currentPagePlotBeatCount = pageMap[this.currentPage.id] || 0;
      }
      if (chapterMap) this.$store.badges.chapterPlotBeatCounts = chapterMap;
    } catch (e) {
      console.error('[refreshPlotBeatCounts]', e);
    }
  },


  // Pro-Seite-Map aktiver Share-Links neu laden (nach Create/Revoke in der
  // Share-Karte) und den „Teilen"-Badge der offenen Seite syncen.
  async refreshShareLinkCounts() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/share/api/page-link-counts?book_id=${bookId}`).catch(() => null);
      if (!map || this.$store.nav.selectedBookId !== bookId) return;
      this.$store.badges.shareLinkCounts = map;
      if (this.currentPage?.id) this.currentPageShareLinkCount = map[this.currentPage.id] || 0;
    } catch (e) {
      console.error('[refreshShareLinkCounts]', e);
    }
  },
};

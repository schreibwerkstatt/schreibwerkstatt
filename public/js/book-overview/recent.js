// Recent-Pages-Tile: zuletzt geöffnete Abschnitte + Zeichen-Badge.
import { RECENT_SHOW_LIMIT } from './load.js';

export const recentMethods = {
  // Der Endpunkt liefert mehr Einträge als angezeigt (RECENT_FETCH_LIMIT);
  // Abschnitte, die nicht mehr im Buch stehen, fallen hier heraus, erst danach
  // wird auf RECENT_SHOW_LIMIT gekürzt.
  overviewRecentPages() {
    const recent = this.overviewRecent || [];
    const pages = Alpine.store('nav').pages || [];
    return this._memo('recentPages', [recent, pages], () => {
      const byId = new Map(pages.map(p => [p.id, p]));
      return recent.map(r => byId.get(r.page_id)).filter(Boolean).slice(0, RECENT_SHOW_LIMIT);
    });
  },

  // Zeichen-Badge pro Recent-Page (aus tokEsts).
  overviewPageChars(pageId) {
    const est = window.__app?.tokEsts?.[pageId];
    return est?.chars ?? null;
  },
};

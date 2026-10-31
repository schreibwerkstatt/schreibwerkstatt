// Tile-Click-Handler der Buch-Uebersicht (Cross-Card-Routings).
//
// Die Formatierer selbst (`_uiLocale`, `_numFmt`, `_dateFmt`, `_fmtNum`,
// `_fmtNormseiten`, `tileFehlerLabel`, `tileInitials`) teilt sich die
// Uebersicht mit dem Kapitel-Dashboard und liegt darum in
// [cards/tile-format.js](../cards/tile-format.js) — hier nur noch
// durchgereicht, damit die Tile-Partials ihren gewohnten Zugriff behalten.
import { EVT } from '../events.js';
import { tileFormatMethods } from '../cards/tile-format.js';

export const formatMethods = {
  ...tileFormatMethods,

  // ── Tile-Click-Handler ───────────────────────────────────────────────────
  _openLengthStats(range = 30, metric = 'chars') {
    window.dispatchEvent(new CustomEvent(EVT.BOOK_STATS_SELECT, { detail: { metric, range } }));
    window.__app?.toggleBookStatsCard?.();
  },

  _openKapitelReview(chapterId) {
    const app = window.__app;
    if (!app) return;
    app.kapitelReviewChapterId = String(chapterId);
    if (!app.showKapitelReviewCard) app.toggleKapitelReviewCard();
  },
};

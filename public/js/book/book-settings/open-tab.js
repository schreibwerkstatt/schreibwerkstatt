// Bucheinstellungen auf einem bestimmten Reiter öffnen — für Verweise aus
// anderen Karten („Klappentext pflegen unter Publikation"), die Palette und den
// Job-Queue-Sprung. Mechanik: cards/card-request.js.

import { openCardWith, takeCardRequest, CARD_REQUEST } from '../../cards/card-request.js';

export function takePendingBookSettingsTab() {
  return takeCardRequest(CARD_REQUEST.BOOK_SETTINGS_TAB);
}

export async function openBookSettingsTab(tab) {
  const app = window.__app;
  if (!app) return;
  await openCardWith(CARD_REQUEST.BOOK_SETTINGS_TAB, tab,
    () => (app.showBookSettingsCard ? null : app.toggleBookSettingsCard?.()));
}

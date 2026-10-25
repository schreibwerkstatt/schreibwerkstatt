// Wunsch an eine Karte, die vielleicht noch gar nicht gemountet ist: „zeig den
// Reiter X", „lade die Session Y". Verweise aus anderen Karten, Palette und
// Job-Queue-Sprung (app-jobs-core.js#navigateToJob) laufen hierüber.
//
// Der Wunsch liegt im Modul statt im Event-Detail: ist die Karte noch nicht
// gemountet (Lazy-Partial), gibt es beim Dispatch keinen Listener — die Karte
// holt ihn dann in init()/onShow ab. Wer zuerst kommt, verbraucht ihn.

import { EVT } from '../events.js';

// Bekannte Wünsche: Schlüssel → wer ihn abholt.
export const CARD_REQUEST = Object.freeze({
  BOOK_SETTINGS_TAB: 'bookSettingsTab',   // cards/book-settings-card.js
  FIGUREN_TAB:       'figurenTab',        // cards/figuren-card.js (figurenGraphModus)
  PAGE_CHAT_SESSION: 'pageChatSession',   // cards/chat-card.js (Session-ID)
  PDF_EXPORT_TAB:    'pdfExportTab',      // cards/pdf-export-ui.js
  USER_SETTINGS_SECTION: 'userSettingsSection', // cards/user-settings-card.js (data-settings-section)
});

const _pending = new Map();

export function takeCardRequest(key) {
  if (!_pending.has(key)) return null;
  const value = _pending.get(key);
  _pending.delete(key);
  return value;
}

// `open` öffnet die Karte (oder tut nichts, wenn sie schon offen ist). Der
// Wunsch steht VOR dem Öffnen bereit, damit init()/onShow ihn sehen; das Event
// danach erreicht eine Karte, die schon offen war.
export async function openCardWith(key, value, open) {
  _pending.set(key, value);
  await open?.();
  window.dispatchEvent(new CustomEvent(EVT.CARD_REQUEST, { detail: { key } }));
}

// Wunsch an eine Karte, die vielleicht noch gar nicht gemountet ist: „zeig den
// Reiter X", „lade die Session Y". Verweise aus anderen Karten, Palette und
// Job-Queue-Sprung (app-jobs-core.js#navigateToJob) laufen hierüber.
//
// Der Wunsch liegt im Modul statt im Event-Detail: ist die Karte noch nicht
// gemountet (Lazy-Partial), gibt es beim Dispatch keinen Listener — die Karte
// holt ihn dann in init()/onShow ab. Wer zuerst kommt, verbraucht ihn.
//
// Zwei Sorten:
//   *_TAB  — schaltet sichtbaren Karten-Zustand um (Reiter, Modus). Muss im
//            selben Flush wie das Einblenden greifen, sonst blitzt der gemerkte
//            Reiter auf (das Event unten kommt erst NACH dem Öffnen). Abholen
//            ausschliesslich über `tabRequest` in setupCardLifecycle — nie
//            selbst takeCardRequest. Gegated: card-tab-request-single-place.
//   übrige — wirkt erst nach dem Laden (Session öffnen, Entwurf einsetzen,
//            Abschnitt anspringen): die Karte holt sie in onShow und im
//            Listener selbst ab.

import { EVT } from '../events.js';

// Bekannte Wünsche: Schlüssel → wer ihn abholt.
export const CARD_REQUEST = Object.freeze({
  BOOK_SETTINGS_TAB: 'bookSettingsTab',   // cards/book-settings-card.js (bookSettingsTab)
  FIGUREN_TAB:       'figurenTab',        // cards/figuren-card.js (figurenGraphModus)
  PAGE_CHAT_SESSION: 'pageChatSession',   // cards/chat-card.js (Session-ID)
  PAGE_CHAT_DRAFT:   'pageChatDraft',     // cards/chat-card.js (Frage fürs Eingabefeld, neues Gespräch)
  BOOK_CHAT_DRAFT:   'bookChatDraft',     // cards/book-chat-card.js (Frage fürs Eingabefeld, neues Gespräch)
  PDF_EXPORT_TAB:    'pdfExportTab',      // cards/pdf-export-card.js (activeTab)
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

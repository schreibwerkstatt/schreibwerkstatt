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
import { SHELF_TABS } from './my-books-compute.js';

// Bekannte Wünsche: Schlüssel → wer ihn abholt.
export const CARD_REQUEST = Object.freeze({
  BOOK_SETTINGS_TAB: 'bookSettingsTab',   // cards/book-settings-card.js (bookSettingsTab)
  FIGUREN_TAB:       'figurenTab',        // cards/figuren-card.js (figurenGraphModus)
  PAGE_CHAT_SESSION: 'pageChatSession',   // cards/chat-card.js (Session-ID)
  PAGE_CHAT_DRAFT:   'pageChatDraft',     // cards/chat-card.js (Frage fürs Eingabefeld, neues Gespräch)
  PAGE_CHAT_QUOTE:   'pageChatQuote',     // cards/chat-card.js (Markierung als Zitat ins Eingabefeld, laufendes Gespräch)
  IDEEN_QUOTE:       'ideenQuote',        // cards/ideen-card.js (Markierung als Zitat ins Ideen-Eingabefeld)
  BOOK_CHAT_DRAFT:   'bookChatDraft',     // cards/book-chat-card.js (Frage fürs Eingabefeld, neues Gespräch)
  PDF_EXPORT_TAB:    'pdfExportTab',      // cards/pdf-export-card.js (activeTab)
  EPUB_EXPORT_TAB:   'epubExportTab',     // cards/epub-export-card.js (activeTab)
  DOCX_EXPORT_TAB:   'docxExportTab',     // cards/docx-export-card.js (activeTab)
  WORTSCHATZ_TAB:    'wortschatzTab',     // cards/wortschatz-card.js (wortschatzTab)
  MOTIV_TAB:         'motivTab',          // cards/motiv-card.js (motivView)
  MY_BOOKS_TAB:      'myBooksTab',        // cards/my-books-card.js (myBooksTab)
  ADMIN_USERS_TAB:   'adminUsersTab',     // cards/admin-users-card.js (adminUsersTab)
  ADMIN_SETTINGS_TAB: 'adminSettingsTab', // cards/admin-settings-card.js (adminSettingsTab)
  USER_SETTINGS_SECTION: 'userSettingsSection', // cards/user-settings-card.js (data-settings-section)
});

// Reiter mit Permalink: Karten-Key (EXCLUSIVE_CARDS) → Reiter-Wunsch, Grund-
// Reiter und gültige Reiter. Die Karte spiegelt ihren aktiven Reiter über
// `tabRequest.current` (card-lifecycle.js) nach `$store.nav.cardTab[request]`;
// der Hash-Router hängt ihn an die Karten-URL (`#book/42/einstellungen/expose`,
// `#admin/users/invites`) und öffnet einen Deep-Link über denselben Reiter-
// Wunsch wie Palette und Querverweise. Der Grund-Reiter erscheint nicht in der
// URL. Ein unbekannter Reiter (alter Link, Tippfehler) wird verworfen.
// `tabs` muss die Reiter des Templates tragen — gegated: url-tabs.test.mjs.
export const URL_TABS = Object.freeze({
  bookSettings:  { request: CARD_REQUEST.BOOK_SETTINGS_TAB, default: 'book',
    tabs: ['book', 'context', 'school', 'sources', 'share', 'publication', 'expose', 'series', 'sync', 'danger'] },
  pdfExport:     { request: CARD_REQUEST.PDF_EXPORT_TAB, default: 'layout',
    tabs: ['layout', 'font', 'chapter', 'pagination', 'frontmatter', 'apparat', 'cover', 'print'] },
  epubExport:    { request: CARD_REQUEST.EPUB_EXPORT_TAB, default: 'typography',
    tabs: ['typography', 'structure', 'metadata'] },
  docxExport:    { request: CARD_REQUEST.DOCX_EXPORT_TAB, default: 'layout',
    tabs: ['layout', 'structure', 'frontmatter'] },
  wortschatz:    { request: CARD_REQUEST.WORTSCHATZ_TAB, default: 'terms',
    tabs: ['terms', 'phrases', 'hapax', 'figures', 'chapters', 'cloud'] },
  motiv:         { request: CARD_REQUEST.MOTIV_TAB, default: 'graph',
    tabs: ['graph', 'band', 'outline', 'checks'] },
  myBooks:       { request: CARD_REQUEST.MY_BOOKS_TAB, default: 'aktiv',
    tabs: SHELF_TABS },
  adminUsers:    { request: CARD_REQUEST.ADMIN_USERS_TAB, default: 'users',
    tabs: ['users', 'invites', 'requests'] },
  adminSettings: { request: CARD_REQUEST.ADMIN_SETTINGS_TAB, default: 'auth',
    tabs: ['auth', 'provider', 'smtp', 'jobs', 'cron', 'pdfa', 'analytics', 'languagetool', 'stt', 'tts', 'image', 'embed', 'geocode', 'websearch', 'api', 'advanced'] },
});

const _urlTabByRequest = new Map(Object.values(URL_TABS).map(t => [t.request, t]));

/** Reiter gültig für diesen Wunsch? Wünsche ohne Permalink-Eintrag: immer. */
export function isKnownTab(requestKey, tab) {
  const spec = _urlTabByRequest.get(requestKey);
  return !spec || spec.tabs.includes(tab);
}

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

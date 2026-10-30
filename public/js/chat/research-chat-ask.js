// Schnittstelle „Im Recherche-Chat fragen" — andere Oberflächen (z.B. der
// Buch-Chat) übergeben eine vorbelegte Frage an den Recherche-Chat:
//
//   window.dispatchEvent(new CustomEvent(EVT.RESEARCH_CHAT_ASK, {   // 'research-chat:ask'
//     detail: { bookId, question },
//   }));
//
// Wirkung: Recherche-Karte öffnen (Registry-Toggle `toggleRechercheCard`), Chat-
// Panel aufklappen, Eingabefeld mit `question` vorbelegen. Es wird NICHT
// automatisch gesendet — der User prüft/ergänzt die Frage und schickt sie selbst
// ab (Web-Suchen kosten). Ein `bookId` eines anderen als des offenen Buchs wird
// ignoriert; ohne nutzbaren Recherche-Chat (`researchChat.enabled` false, Gate) ebenso.
//
// Event-Name: EVT.RESEARCH_CHAT_ASK (public/js/events.js).
// Die Karte ist lazy (Partial wird erst beim Öffnen geladen) — darum hält dieses
// Modul die Frage als „pending", bis die Karte sie abholt: sofort, wenn sie schon
// lebt (Event `research-chat:ask-pending`), sonst in ihrem init().
// Doku: docs/recherche-chat.md („Vorbelegte Frage aus anderen Oberflächen").

import { EVT } from '../events.js';

// Event-Namen leben in der Registry (events.js); hier nur Aliase für Importeure.
export const RESEARCH_CHAT_ASK = EVT.RESEARCH_CHAT_ASK;
export const RESEARCH_CHAT_ASK_PENDING = EVT.RESEARCH_CHAT_ASK_PENDING;
const QUESTION_MAX = 4000;

let _pending = null;

/** Wartende Frage abholen (einmalig). */
export function takePendingResearchAsk() {
  const p = _pending;
  _pending = null;
  return p;
}

function _onAsk(e) {
  const app = window.__app;
  const nav = window.Alpine?.store('nav');
  const question = String(e?.detail?.question || '').trim().slice(0, QUESTION_MAX);
  if (!question || !app || !nav?.selectedBookId) return;
  const bookId = e.detail?.bookId;
  if (bookId != null && String(bookId) !== String(nav.selectedBookId)) return;
  if (!window.Alpine.store('config')?.researchChatEnabled) return;
  _pending = { question };
  // Karte öffnen, falls zu (der Registry-Toggle lädt das Partial nach). Ist sie
  // offen, kein Toggle — `onReclick: 'refresh'` würde das Board neu laden.
  if (!app.showRechercheCard && typeof app.toggleRechercheCard === 'function') app.toggleRechercheCard();
  window.dispatchEvent(new CustomEvent(RESEARCH_CHAT_ASK_PENDING));
}

let _installed = false;
/** Einmalig beim Registrieren der Recherche-Karte (Boot) aufrufen. */
export function installResearchChatAskBridge() {
  if (_installed || typeof window === 'undefined') return;
  _installed = true;
  window.addEventListener(RESEARCH_CHAT_ASK, _onAsk);
}

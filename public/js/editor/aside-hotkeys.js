// Tastaturweg in die Leiste neben dem Notebook-Editor: ⌘/Strg+Shift+1 =
// Abschnitts-Chat, ⌘/Strg+Shift+2 = Ideen zum Abschnitt. Gilt in Lese- und
// Bearbeiten-Ansicht des Notebook-Editors, nicht im Focus-Editor (dort ist die
// Leiste ausgeblendet) und nicht im Bucheditor.
//
// Ein Druck auf das Kürzel:
//   - Leiste zu            → öffnen, Eingabefeld fokussieren
//   - Leiste offen, Fokus im Text → ins Eingabefeld springen
//   - Fokus schon im Eingabefeld  → Leiste schliessen, zurück in den Text
// Markierter Text wird als Zitat ins Eingabefeld gelegt (nichts wird gesendet
// oder gespeichert). Esc im Eingabefeld führt an die gemerkte Textstelle
// zurück, die Leiste bleibt offen (`returnFromAside`).
//
// Ausgewertet wird `event.code` (physische Ziffer), nicht `event.key`: Shift+1
// ergibt je nach Layout «!» (US) oder «+» (DE/CH).

import { openCardWith, CARD_REQUEST } from '../cards/card-request.js';

const SLOT_BY_CODE = { Digit1: 'chat', Digit2: 'ideen' };

// Eingabefeld der jeweiligen Leiste (partials/chat.html bzw. ideen.html).
const INPUT_SEL = {
  chat: '#partial-chat .chat-input',
  ideen: '#ideen-card .ideen-input',
};

// Gemerkte Textstelle, an die Esc zurückführt. Bewusst Modul-Variablen statt
// Alpine-State: eine Range im reaktiven Proxy wäre ein Fremdkörper, und
// niemand rendert sie. `_lastTextSpot` folgt jeder Auswahl im Abschnittstext
// (selectionchange) — so findet auch der Weg über die Palette zurück, bei dem
// die Auswahl beim Öffnen schon ins Suchfeld gewandert ist.
let _returnSpot = null;
let _lastTextSpot = null;

function _pageContentHost(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const host = el?.closest?.('.page-content-view');
  if (!host || host.classList.contains('revision-viewer__content')) return null;
  return host;
}

// Aktuelle Auswahl/Caret, sofern sie im Abschnittstext liegt.
export function captureTextSpot() {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!_pageContentHost(range.commonAncestorContainer)) return null;
  return { range: range.cloneRange(), text: sel.toString() };
}

if (typeof document !== 'undefined') {
  document.addEventListener('selectionchange', () => {
    const spot = captureTextSpot();
    if (spot) _lastTextSpot = spot;
  });
}

// Markierung → Zitat fürs Eingabefeld. Whitespace wird zu einer Zeile
// zusammengezogen (Absatzgrenzen kämen sonst als Leerzeilen mit), ein
// angefangener Entwurf bleibt davor stehen. Leere Markierung → unverändert.
export function quoteIntoDraft(existing, selected, quoteFn) {
  const text = String(selected || '').replace(/\s+/g, ' ').trim();
  const draft = String(existing || '');
  if (!text) return draft;
  const quote = quoteFn(text);
  if (!draft.trim()) return quote + '\n';
  return draft.replace(/\s+$/, '') + '\n\n' + quote + '\n';
}

// Eingabefeld befüllen und Caret ans Ende. Von chat-card.js / ideen-card.js
// aufgerufen, sobald die Karte den Wunsch abholt.
export function applyQuoteToInput(component, field, inputEl, selected) {
  if (!selected) return;
  component[field] = quoteIntoDraft(component[field], selected, (s) => window.__app.t('aside.quote', { text: s }));
  requestAnimationFrame(() => {
    if (!inputEl) return;
    inputEl.focus();
    const end = inputEl.value.length;
    try { inputEl.setSelectionRange(end, end); } catch {}
  });
}

function _focusInput(slot) {
  const until = performance.now() + 2000;
  const tryFocus = () => {
    const el = document.querySelector(INPUT_SEL[slot]);
    if (el && el.offsetParent) { el.focus(); return; }
    if (performance.now() < until) requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
}

export const asideHotkeyMethods = {
  // Darf die Leiste `slot` gerade per Tastatur/Palette auf? Dieselben
  // Bedingungen wie die Knöpfe in editor-page-actions.html.
  canOpenPageAside(slot) {
    if (!this.showEditorCard || !this.currentPage || this.focusActive) return false;
    if (slot === 'chat') return !!this.canReview?.() && !this.currentPageEmpty;
    return slot === 'ideen';
  },

  _asideOpen(slot) {
    if (slot === 'chat') return !!this.showChatCard;
    return !!this.showIdeenCard && this.ideenScope === 'page';
  },

  handleAsideHotkey(event) {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
    const slot = SLOT_BY_CODE[event.code];
    if (!slot) return;
    if (!this.canOpenPageAside(slot)) return;
    event.preventDefault();
    this.openPageAsideFromKeyboard(slot);
  },

  // Gemeinsamer Weg für Kürzel und Palette.
  // Aus der Palette (`fromPalette`) wird nie geschlossen — Palette heisst
  // «hingehen» (palette-card.js#activateItem).
  async openPageAsideFromKeyboard(slot, { fromPalette = false } = {}) {
    if (!this.canOpenPageAside(slot)) return;
    const input = document.querySelector(INPUT_SEL[slot]);
    const open = this._asideOpen(slot);
    if (!fromPalette && open && input && document.activeElement === input) {
      if (slot === 'chat') await this.toggleChatCard();
      else await this.toggleIdeenCard();
      this.returnFromAside();
      return;
    }
    // Zitat nur aus der Auswahl, die JETZT im Text steht; zurück geht es
    // notfalls an die letzte bekannte Stelle (Palette, Fokus in der Leiste).
    const spot = captureTextSpot();
    _returnSpot = spot || _lastTextSpot;
    const selected = spot?.text?.trim() ? spot.text : '';
    const toggle = slot === 'chat' ? () => this.toggleChatCard() : () => this.toggleIdeenCard();
    const key = slot === 'chat' ? CARD_REQUEST.PAGE_CHAT_QUOTE : CARD_REQUEST.IDEEN_QUOTE;
    await openCardWith(key, selected, open ? null : toggle);
    if (!selected) _focusInput(slot);
  },

  // Esc im Eingabefeld von Chat/Ideen: Caret bzw. Markierung an die gemerkte
  // Stelle im Text zurück (auch wenn die Leiste per Maus aufging — dann die
  // letzte Auswahl im Text). Ohne jede Stelle im Bearbeiten-Modus in den Text,
  // sonst nur aus dem Feld heraus.
  returnFromAside(event) {
    if (event?.isComposing) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const editEl = document.querySelector('.page-content-view--editing');
    // Erste noch gültige Stelle: ein gemerkter Rücksprung einer früheren Seite
    // ist abgehängt — dann die letzte Auswahl im aktuellen Text.
    const usable = (s) => s && s.range.startContainer.isConnected && _pageContentHost(s.range.startContainer);
    const spot = [_returnSpot, _lastTextSpot].find(usable) || null;
    if (spot) {
      if (editEl && editEl.contains(spot.range.startContainer)) editEl.focus({ preventScroll: true });
      else document.activeElement?.blur?.();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(spot.range);
      const el = spot.range.startContainer.nodeType === 1 ? spot.range.startContainer : spot.range.startContainer.parentElement;
      el?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (editEl) editEl.focus();
    else document.activeElement?.blur?.();
  },
};

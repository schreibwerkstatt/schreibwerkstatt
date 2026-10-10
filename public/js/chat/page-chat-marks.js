// Seiten-Chat: Zustand der Vorschläge gegen die aktuelle Seite (veraltet /
// rückgängig-fähig / Wort-Diff), Inline-Marken der Leseansicht und das
// Hinzeigen auf eine Stelle (Hover/Klick auf einen Vorschlag). In `chatCard`
// gespreadet (über chat.js); `this` ist die Karte.

import { countInHtml } from '../utils.js';
import { foldQuotes, normalizeMatchText } from '../utils/text-match.js';
import { stripLektoratMarks } from '../editor/shared/html-clean.js';
import { collectTextNodes, createHighlightPair } from '../editor/shared/text-find.js';
import { wordDiff } from './word-diff.js';

// CSS-Custom-Highlight (kein DOM-Eingriff — landet nie im gespeicherten HTML).
// Nur der „current"-Name wird gemalt; Stil in css/editor/notebook/lektorat.css.
const locateHighlight = createHighlightPair('chat-proposal-match', 'chat-proposal-focus');

const VIEW_SEL = '.page-content-view:not(.page-content-view--editing):not(.revision-viewer__content)';

/** HTML, gegen das Vorschläge geprüft werden: im Notebook-Edit-Modus der
 *  Live-Editor (dort landet ein Übernehmen), sonst der gespeicherte Stand. */
export function pageChatHtml(root) {
  if (root?.editMode && !root.focusActive) {
    const el = root._getEditEl?.();
    if (el) return stripLektoratMarks(el.innerHTML);
  }
  return root?.originalHtml || '';
}

/** Offene Vorschläge der letzten Assistant-Nachricht als Inline-Marken.
 *  Nur die letzte: sonst mischen sich frische Vorschläge mit denen aus der
 *  Historie; ältere bleiben in den Chat-Bubbles sichtbar. */
export function computeChatMarks(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  let last = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { last = i; break; }
  }
  if (last === -1 || !Array.isArray(msgs[last].vorschlaege)) return [];
  const out = [];
  msgs[last].vorschlaege.forEach((v, vIdx) => {
    if (v._applied || v._discarded || v._stale || v._notFound || !v.original || !v.ersatz) return;
    out.push({ msgIdx: last, vIdx, original: v.original, ersatz: v.ersatz });
  });
  return out;
}

/** Erste Fundstelle von `needle` unter `container` als Match-Tupel
 *  ({ startNode, startOffset, endNode, endOffset }) oder null — mit derselben
 *  Toleranz wie `countInHtml` (Whitespace kollabiert, Anführungszeichen
 *  gefaltet), damit Hervorhebung und Apply-Guard dieselbe Stelle meinen: nach
 *  dem Übernehmen stehen die Anführungszeichen im Buch-Stil, der Vorschlag hat
 *  sie gerade. Text-Nodes werden ohne Trenner verkettet (Inline-Tags tragen
 *  ihren Leerraum selbst); Block-Grenzen überspannt ein Vorschlag nie. */
export function locateInContainer(container, needle) {
  const n = normalizeMatchText(needle);
  if (!container || !n) return null;
  const nodes = collectTextNodes(container);
  const chars = [];
  const pos = [];
  let pendingSpace = false;
  for (const node of nodes) {
    const v = node.nodeValue || '';
    for (let i = 0; i < v.length; i++) {
      if (/\s/.test(v[i])) { if (chars.length) pendingSpace = true; continue; }
      if (pendingSpace) { chars.push(' '); pos.push({ node, i }); pendingSpace = false; }
      chars.push(v[i]);
      pos.push({ node, i });
    }
  }
  const idx = foldQuotes(chars.join('')).indexOf(n);
  if (idx === -1) return null;
  const a = pos[idx];
  const b = pos[idx + n.length - 1];
  return { startNode: a.node, startOffset: a.i, endNode: b.node, endOffset: b.i + 1 };
}

// Steckt das Original im Ersatz („Haus" → „das Haus"), sagt ein wieder
// auffindbares Original nichts über ein Zurücknehmen — es kann Rest einer
// späteren Bearbeitung sein. Dann bleibt „übernommen" stehen.
function _ersatzContainsOriginal(v) {
  return normalizeMatchText(v.ersatz).includes(normalizeMatchText(v.original));
}

export const pageChatMarksMethods = {

  // Abgeleitete Flags pro Vorschlag. Läuft nach jedem Laden der Session, nach
  // jedem Übernehmen/Rückgängig/Verwerfen, nach Job-Ende und wenn sich der
  // Seitenstand ändert (chat-card.js):
  //   _applied/_discarded — Spiegel der persistierten Felder (applied / status)
  //   _notFound — offen, die Stelle stand schon beim Erzeugen nicht im Text
  //               (Server-Prüfung `match: 'not_found'`) und steht auch jetzt nicht da
  //   _stale    — offen, die Originalstelle stand da, steht aber nicht mehr in der Seite
  //   _ambiguous — offen, die Stelle kommt mehrfach vor (Übernehmen bricht ab)
  //   _undoable — übernommen, und der Ersatztext steht noch genau einmal da
  //   _diff     — Wort-Diff original → ersatz (null = zu gross, zwei Blöcke)
  //
  // Übernommen, aber der Ersatz ist weg und das Original steht wieder genau
  // einmal da (Strg+Z im Editor, Bearbeiten abgebrochen, Fassung zurückgeholt):
  // dann ist der Vorschlag wieder offen — persistiert, sonst käme „übernommen"
  // beim nächsten Laden zurück.
  _refreshVorschlagStates() {
    const html = pageChatHtml(window.__app);
    for (const m of this.chatMessages) {
      if (!Array.isArray(m.vorschlaege)) continue;
      m.vorschlaege.forEach((v, vIdx) => {
        if (html && v.applied && !v._applying && !_ersatzContainsOriginal(v)
            && countInHtml(html, v.ersatz) === 0 && countInHtml(html, v.original) === 1) {
          delete v.applied;
          delete v.applied_at;
          if (m.id) this._patchChatVorschlag?.(m.id, vIdx, 'applied', { applied: false });
        }
        v._applied = !!v.applied;
        v._discarded = !v._applied && v.status === 'discarded';
        const open = !!html && !v._applied && !v._discarded;
        const n = open ? countInHtml(html, v.original) : -1;
        v._notFound = n === 0 && v.match === 'not_found';
        v._stale = n === 0 && !v._notFound;
        v._ambiguous = n > 1;
        v._undoable = !!html && v._applied && countInHtml(html, v.ersatz) === 1;
        if (v._diff === undefined) v._diff = wordDiff(v.original, v.ersatz);
      });
    }
    this._publishChatMarks();
  },

  _publishChatMarks() {
    const store = window.Alpine?.store('pageChat');
    if (store) store.proposals = computeChatMarks(this.chatMessages);
    window.__app?.updatePageView?.();
  },

  _clearChatMarks() {
    const store = window.Alpine?.store('pageChat');
    if (store) store.proposals = [];
    locateHighlight.clear();
  },

  // Hover über einen Vorschlag → Stelle im Text hervorheben; `scroll` (Klick)
  // zusätzlich hinscrollen. Sucht im aktiven Container (Live-Editor bzw.
  // Leseansicht) den Originaltext — bei übernommenen Vorschlägen den Ersatz.
  locateChatVorschlag(v, { scroll = false } = {}) {
    const root = window.__app;
    const container = root?.editMode
      ? (root.focusActive ? null : root._getEditEl?.())
      : document.querySelector(VIEW_SEL);
    const needle = v?._applied ? v.ersatz : v?.original;
    const match = locateInContainer(container, needle);
    if (!match) { locateHighlight.clear(); return; }
    locateHighlight.paint([match], 0);
    if (scroll) match.startNode?.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  },

  unlocateChatVorschlag() { locateHighlight.clear(); },
};

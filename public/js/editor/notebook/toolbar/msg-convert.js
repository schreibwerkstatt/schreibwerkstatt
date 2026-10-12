// editorToolbarCard: markierte Absätze → Nachrichtenverlauf (Bubble-Leiste).
// `this` = Sub-Komponente (editorToolbarCard), Root-Zugriffe via window.__app.
//
// Jeder erfasste Absatz wird eine Nachricht; die erste bekommt die gewählte
// Seite, danach wechseln die Seiten ab (Zwiegespräch). Keine Mustererkennung
// für Absender oder Uhrzeit — Absender und Hinweis setzt danach die
// Zeilenleiste, eine falsch zugeordnete Seite korrigiert Tab. Anführungszeichen
// um eine ganze Zeile fallen weg: im Verlauf ist der Block die Markierung der
// Rede (docs/nachrichtenverlauf.md, «Zählt das als Prosa?»).
//
// Nur Notebook: die Bubble ist im Focus-Editor aus (Template + _updateBubble).
// Markup ausschliesslich über die SSoT messages/msg-html.js.

import { getEditEl } from './_shared.js';
import {
  isMsgThreadEl, setMsgKind, toggleMsgSide, MSG_THREAD_CLASS,
} from '../../../messages/msg-html.js';

// Öffnende/schliessende Zeichen, die eine ganze Zeile als Rede umschliessen
// können. Einfache Apostrophe (' ’) fehlen bewusst: «'s Wetter» oder «hab'»
// sind Elisionen, keine Anführung.
const OPEN_QUOTES = '„“”"«»‹›‚';
const CLOSE_QUOTES = '“”"»«›‹‘';
const ALL_QUOTES = new Set([...OPEN_QUOTES, ...CLOSE_QUOTES]);

// Absätze auf oberster Ebene, die die Selektion berührt — nur wenn ALLE davon
// schlichte <p> sind (keine Liste, Überschrift, Zitat, kein Verlauf). Sonst [].
export function msgConvertTargets(range, editEl) {
  if (!range || !editEl) return [];
  const blocks = [];
  for (const child of editEl.children) {
    if (!range.intersectsNode(child)) continue;
    // Selektion, die genau am Anfang des nächsten Absatzes endet (Dreifachklick),
    // erfasst ihn nicht wirklich.
    if (blocks.length && range.endContainer === child && range.endOffset === 0) continue;
    blocks.push(child);
  }
  if (!blocks.length) return [];
  const plain = blocks.every(b => b.tagName === 'P' && !b.className);
  return plain ? blocks : [];
}

function textNodes(el) {
  const out = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.data.trim()) out.push(n);
  }
  return out;
}

// Anführungszeichen um die ganze Zeile entfernen: führendes öffnendes Zeichen
// und — falls vorhanden — schliessendes am Ende (mehrabsätzige Rede schliesst
// erst im letzten Absatz). Enthält der Rest weitere Anführungszeichen
// («„Ja“, sagte sie, „gern“»), ist es keine reine Rede-Zeile und bleibt stehen.
export function stripLineQuotes(line) {
  const nodes = textNodes(line);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const lead = first.data.match(/^\s*/)[0].length;
  if (!OPEN_QUOTES.includes(first.data[lead])) return;
  const trailWs = last.data.match(/\s*$/)[0].length;
  const endIdx = last.data.length - trailWs - 1;
  const hasClose = CLOSE_QUOTES.includes(last.data[endIdx]) && !(first === last && endIdx === lead);
  const inner = (line.textContent || '').trim().slice(1, hasClose ? -1 : undefined);
  if ([...inner].some(ch => ALL_QUOTES.has(ch))) return;
  if (hasClose) last.data = last.data.slice(0, endIdx) + last.data.slice(endIdx + 1);
  first.data = first.data.slice(0, lead) + first.data.slice(lead + 1);
}

function isEmptyLine(p) {
  return !(p.textContent || '').trim() && !p.querySelector(':not(br)');
}

export const msgConvertMethods = {
  // `firstKind` = 'in' | 'out': Seite der ersten Nachricht.
  toolbarToMsgThread(firstKind) {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    const sel = document.getSelection();
    if (!editEl || !sel || sel.rangeCount === 0) return;
    const blocks = msgConvertTargets(sel.getRangeAt(0), editEl);
    const lines = blocks.filter(b => !isEmptyLine(b));
    if (!lines.length) return;

    // Vorher-Stand als eigenen Undo-Schritt einfrieren (offene Tipp-Serie
    // inklusive), Nachher-Stand sofort — Muster edit/input.js#_onEditPaste.
    app._historyPushNow?.();

    const thread = document.createElement('div');
    thread.className = MSG_THREAD_CLASS;
    blocks[0].before(thread);
    let kind = firstKind === 'out' ? 'out' : 'in';
    for (const p of lines) {
      stripLineQuotes(p);
      setMsgKind(p, kind);
      thread.appendChild(p);
      kind = toggleMsgSide(kind);
    }
    for (const b of blocks) if (b.parentNode === editEl) b.remove();

    // Angrenzende Verläufe zu einem zusammenziehen — sonst stünden zwei
    // Blöcke ohne Erzählabsatz dazwischen untereinander.
    let merged = thread;
    const prev = merged.previousElementSibling;
    if (isMsgThreadEl(prev)) { prev.append(...merged.childNodes); merged.remove(); merged = prev; }
    const next = merged.nextElementSibling;
    if (isMsgThreadEl(next)) { merged.append(...next.childNodes); next.remove(); }

    const end = document.createRange();
    end.selectNodeContents(lines[lines.length - 1]);
    end.collapse(false);
    sel.removeAllRanges();
    sel.addRange(end);
    this.bubbleShow = false;
    app._markEditDirty?.();
    app._historyPushNow?.();
  },
};

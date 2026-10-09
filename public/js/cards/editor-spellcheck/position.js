// Popover-Geometrie fuer den Spellcheck-Controller — pure DOM-Mathematik ohne
// Controller-State. Zwei Host-Varianten, weil der Popover ins Scroll-Layer
// eingehaengt wird, damit Scroll ihn physisch mitnimmt (kein JS-Reposition, kein
// 1-Frame-Trail):
//
//   - scrollEl == window/scrollingElement: Popover an <body>, position absolute
//     in Dokument-Koordinaten (anchorRect + window.scrollX/Y). Window-Scroll
//     bewegt body-Kinder nativ. Gilt fuer den Bucheditor.
//   - scrollEl interner Container (Notebook=.page-content-view--editing,
//     Focus=.focus-editor__content, beide gleichzeitig contenteditable):
//     Popover als Kind dort einhaengen, position absolute in
//     Scroll-Content-Koordinaten. Er ist contenteditable="false" und damit eine
//     nicht-editbare Insel; Caret/Selection greift nicht hinein.

const PADDING = 8;
const GAP = 4;
// Kleinste sinnvolle gekappte Hoehe (Header + eine Vorschlagszeile).
const MIN_CAPPED = 96;

// Waehlt das Host-Element und stellt sicher, dass es Offset-Parent fuer ein
// absolut positioniertes Kind ist.
export function resolvePopoverHost(scrollEl) {
  const useScroller = scrollEl
    && scrollEl !== window
    && scrollEl !== document.scrollingElement
    && scrollEl !== document.documentElement
    && scrollEl !== document.body;
  if (!useScroller) return document.body;
  if (getComputedStyle(scrollEl).position === 'static') {
    scrollEl.style.position = 'relative';
  }
  return scrollEl;
}

export function positionPopover(el, anchorRect, host) {
  if (host === document.body) _positionInBodyAbsolute(el, anchorRect);
  else _positionInsideScroller(el, anchorRect, host);
}

function _positionInsideScroller(el, anchorRect, host) {
  const hostRect = host.getBoundingClientRect();
  // Vertical: clamp/flip gegen den SICHTBAREN Host-Bereich, nicht gegen das
  // Window. Der Notebook-Scroller hat max-height:70vh + overflow-y:auto; sein
  // sichtbarer Boden liegt darum meist deutlich oberhalb von innerHeight.
  // Ein nach unten platziertes Popover an den letzten Zeilen passt zwar ins
  // Window, ragt aber unter den Scroller-Sichtbereich — overflow:auto clippt
  // es weg ("verrutscht ganz unten", v.a. Edge). Schnittmenge Host∩Window.
  const visTop = Math.max(hostRect.top, 0);
  const visBottom = Math.min(hostRect.bottom, window.innerHeight);
  const viewportTop = placeVertical(el, anchorRect, visTop, visBottom);
  // Horizontal: clamp gegen Host-Sichtbereich (Popover bleibt im Scroll-Slot).
  const pr = el.getBoundingClientRect();
  let viewportLeft = anchorRect.left;
  const hostRight = hostRect.left + host.clientWidth;
  if (viewportLeft + pr.width + PADDING > hostRight) {
    viewportLeft = Math.max(hostRect.left + PADDING, hostRight - pr.width - PADDING);
  }
  if (viewportLeft < hostRect.left + PADDING) viewportLeft = hostRect.left + PADDING;
  el.style.left = `${viewportLeft - hostRect.left + host.scrollLeft}px`;
  el.style.top  = `${viewportTop  - hostRect.top  + host.scrollTop}px`;
}

function _positionInBodyAbsolute(el, anchorRect) {
  const vw = window.innerWidth;
  const viewportTop = placeVertical(el, anchorRect, 0, window.innerHeight);
  const pr = el.getBoundingClientRect();
  let viewportLeft = anchorRect.left;
  if (viewportLeft + pr.width + PADDING > vw) {
    viewportLeft = Math.max(PADDING, vw - pr.width - PADDING);
  }
  el.style.left = `${viewportLeft + window.scrollX}px`;
  el.style.top  = `${viewportTop  + window.scrollY}px`;
}

// Vertikale Platzierung im sichtbaren Band [visTop, visBottom]: unter dem Anker,
// sonst darueber. Passt der Popover auf keiner Seite, kommt er auf die
// geraeumigere und wird per max-height auf deren Platz gekappt (scrollt
// intern) — er wird NIE auf den Anker geklemmt. Ein Popover ueber dem Wort
// nimmt dem User das Wort weg: kein Klick, keine Selektion mehr darin.
// Liefert die Viewport-Oberkante.
export function placeVertical(el, anchorRect, visTop, visBottom) {
  el.style.maxHeight = '';
  const h = el.getBoundingClientRect().height;
  const below = anchorRect.bottom + GAP;
  const spaceBelow = visBottom - PADDING - below;
  const spaceAbove = anchorRect.top - GAP - (visTop + PADDING);
  if (h <= spaceBelow) return below;
  if (h <= spaceAbove) return anchorRect.top - GAP - h;
  // Unterhalb bleibt der Fallback auch bei wenig Platz: dort ragt der Popover
  // hoechstens aus dem Sichtbereich (scrollbar), deckt aber nichts zu.
  if (spaceAbove > spaceBelow && spaceAbove >= MIN_CAPPED) {
    el.style.maxHeight = `${spaceAbove}px`;
    return anchorRect.top - GAP - spaceAbove;
  }
  if (spaceBelow >= MIN_CAPPED) el.style.maxHeight = `${spaceBelow}px`;
  return below;
}

// Geometrie der am Trigger verankerten, nach <body> teleportierten Popover.
//
// Konsumenten: das Ideen-Meatball-Menue (book/ideen.js#openMenu), das Plot-Lane-
// Menue (book/plot/threads.js#openThreadMenu), das Plot-Fundstellen-Popover
// (book/plot/ai.js#openBeatOccPopover) und der Verknuepfungs-Picker der Ideen
// (book/ideen-links.js#openLinkPicker), dazu die Hover-Vorschau der Entitaets-
// Referenz (entity-ref-popover.js, `align: 'start'`, ohne Schaetz-Pass: sie misst
// synchron nach dem Befuellen). Die Menues teleportieren aus ihrem Container
// heraus (nach <body>, die beiden Plot-Popover in die Karten-Wurzel `.card--plot`
// wegen des Native-Vollbilds), weil der Container scrollt oder `overflow` klippt,
// und brauchen dieselbe Rechnung — sie liegt darum hier und nicht mehrfach daneben.
//
// Zwei Paesse sind Pflicht, nicht Geschmack: `computePopoverPos` positioniert mit
// einer Schaetzung, damit im ersten Frame nichts an der falschen Stelle
// aufblitzt; `refinePopoverPos` misst danach die ECHTE Groesse und setzt neu.
// Ohne den zweiten Pass loest sich ein nach oben geklapptes Popover vom Button,
// sobald die Schaetzung groesser war als das gerenderte Element. Gegated:
// tests/unit/popover-flip-measure.test.mjs.
//
// Die Popover selbst sind `position: fixed` — `top`/`left` sind darum Viewport-
// Koordinaten, direkt aus `getBoundingClientRect()` des Triggers.

// Abstand zum Trigger und Mindestabstand zum Viewport-Rand.
const GAP = 4;
const EDGE = 8;

/**
 * Position eines am Trigger verankerten Popovers.
 * Rechtsbuendig zum Trigger (Menue-Knoepfe sitzen am rechten Rand), mit
 * `align: 'start'` linksbuendig (Hover-Vorschau eines Chips im Fliesstext);
 * darunter — und darueber, wenn unten kein Platz ist.
 *
 * @param {DOMRect|{top:number,bottom:number,left?:number,right:number}} r Trigger-Rect (Viewport).
 * @param {number} pw Popover-Breite  (Schaetzung im ersten Pass, gemessen im zweiten).
 * @param {number} ph Popover-Hoehe   (dito).
 * @param {{align?: 'end'|'start'}} [opts]
 * @returns {{top:number,left:number}}
 */
export function computePopoverPos(r, pw, ph, { align = 'end' } = {}) {
  const ideal = align === 'start' ? r.left : r.right - pw;
  const left = Math.max(EDGE, Math.min(window.innerWidth - pw - EDGE, ideal));
  const top = (r.bottom + ph + EDGE > window.innerHeight)
    ? Math.max(EDGE, r.top - ph - GAP)
    : r.bottom + GAP;
  return { top, left };
}

/**
 * Zweiter Pass: aus dem gerenderten Popover die echte Groesse lesen und die
 * Position damit neu rechnen. Aufruf gehoert in `$nextTick` nach dem Oeffnen.
 *
 * @param {HTMLElement|null|undefined} el Das gerenderte Popover ($refs).
 * @param {DOMRect|null|undefined} rect Das beim Oeffnen gemerkte Trigger-Rect.
 * @returns {{top:number,left:number}|null} null, wenn nichts zu messen ist.
 */
export function refinePopoverPos(el, rect) {
  if (!el || !rect) return null;
  return computePopoverPos(rect, el.offsetWidth, el.offsetHeight);
}

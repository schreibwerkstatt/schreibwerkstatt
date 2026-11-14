// Geometrie der am Trigger verankerten, nach <body> teleportierten Popover.
//
// Konsumenten: die caret-verankerten Panels des Notebook-Editors (Link-Bar,
// Beleg- und Querverweis-Picker, editor/notebook/toolbar/panel-methods.js —
// mit `viewportBand()` als Bezugsrahmen), die teleportierten Aktionsmenues
// (action-menu.js — Ideen, Plot-Strang, Recherche, …), das Plot-Fundstellen-Popover
// (book/plot/ai.js#openBeatOccPopover) und die Picker-Popover
// (picker-popover.js#_openPickerPopover), dazu die Hover-Vorschau der Entitaets-
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
 * Sichtbares Band in Client-Koordinaten (dieselbe Ebene wie
 * `getBoundingClientRect`). Auf Mobile ist das der `visualViewport`: die
 * Bildschirmtastatur schrumpft (und verschiebt) ihn, waehrend
 * `window.innerHeight` unveraendert bleibt — ein Popover in einem Editor, das
 * nach `innerHeight` rechnet, landet hinter der Tastatur (public/CLAUDE.md
 * «Flip-up-Popover messen statt raten» → Bezugsrahmen).
 *
 * @returns {{top:number,left:number,width:number,height:number}}
 */
export function viewportBand() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return {
    top: vv ? vv.offsetTop : 0,
    left: vv ? vv.offsetLeft : 0,
    width: vv ? vv.width : window.innerWidth,
    height: vv ? vv.height : window.innerHeight,
  };
}

/**
 * Position eines am Trigger verankerten Popovers.
 * Rechtsbuendig zum Trigger (Menue-Knoepfe sitzen am rechten Rand), mit
 * `align: 'start'` linksbuendig (Hover-Vorschau eines Chips im Fliesstext),
 * mit `align: 'center'` mittig ueber dem Anker (Panels am Caret);
 * darunter — und darueber, wenn unten kein Platz ist. `prefer: 'above'` kehrt
 * die Vorzugsrichtung um (Panels am Caret: der Text darunter bleibt lesbar).
 * `band` ist der Bezugsrahmen (Default: das Layout-Viewport; Editor-Panels
 * geben `viewportBand()` mit).
 *
 * @param {DOMRect|{top:number,bottom:number,left?:number,right:number}} r Trigger-Rect (Viewport).
 * @param {number} pw Popover-Breite  (Schaetzung im ersten Pass, gemessen im zweiten).
 * @param {number} ph Popover-Hoehe   (dito).
 * @param {{align?: 'end'|'start'|'center', prefer?: 'below'|'above', band?: {top:number,left:number,width:number,height:number}}} [opts]
 * @returns {{top:number,left:number}}
 */
export function computePopoverPos(r, pw, ph, { align = 'end', prefer = 'below', band = null } = {}) {
  const b = band || { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  const bandRight = b.left + b.width;
  const bandBottom = b.top + b.height;
  // Rechtsbuendig ragte ein Popover an einem Trigger nahe dem LINKEN Rand
  // (Knopf am Zeilenanfang, z.B. «Verknuepfen» im Recherche-Dialog) links aus
  // dem Viewport und wuerde an den Rand geklemmt — dann stuende es losgeloest
  // vom Trigger, halb ausserhalb seines Dialogs. In diesem Fall linksbuendig
  // am Trigger ansetzen, sofern es so passt.
  const flipStart = align === 'end' && r.left != null
    && r.right - pw < b.left + EDGE && r.left + pw <= bandRight - EDGE;
  let ideal;
  if (align === 'center') ideal = ((r.left ?? r.right) + r.right) / 2 - pw / 2;
  else ideal = (align === 'start' || flipStart) ? r.left : r.right - pw;
  const left = Math.max(b.left + EDGE, Math.min(bandRight - pw - EDGE, ideal));
  const fitsBelow = r.bottom + ph + EDGE <= bandBottom;
  if (prefer === 'above') {
    const fitsAbove = r.top - ph - GAP >= b.top + EDGE;
    // Oben passt nicht: nach unten, sofern dort mehr Platz ist; sonst oben
    // bleiben und an die Bandkante klemmen (max-height begrenzt den Rest).
    const goBelow = !fitsAbove && (fitsBelow || (bandBottom - r.bottom) > (r.top - b.top));
    const raw = goBelow ? r.bottom + GAP : r.top - ph - GAP;
    const top = Math.max(b.top + EDGE, Math.min(bandBottom - ph - EDGE, raw));
    return { top, left };
  }
  const top = fitsBelow
    ? r.bottom + GAP
    : Math.max(b.top + EDGE, r.top - ph - GAP);
  return { top, left };
}

/**
 * Zweiter Pass: aus dem gerenderten Popover die echte Groesse lesen und die
 * Position damit neu rechnen. Aufruf gehoert in `$nextTick` nach dem Oeffnen.
 *
 * @param {HTMLElement|null|undefined} el Das gerenderte Popover ($refs).
 * @param {DOMRect|null|undefined} rect Das beim Oeffnen gemerkte Trigger-Rect.
 * @param {object} [opts] Dieselben Optionen wie bei `computePopoverPos`.
 * @returns {{top:number,left:number}|null} null, wenn nichts zu messen ist.
 */
export function refinePopoverPos(el, rect, opts) {
  if (!el || !rect) return null;
  return computePopoverPos(rect, el.offsetWidth, el.offsetHeight, opts);
}

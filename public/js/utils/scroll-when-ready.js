// Gemeinsamer Scroll-Helfer für Sprünge (Karte öffnen, Zeile anspringen,
// Fundstelle markieren). Smooth-Scroll ist auf dem Handy empfindlich: eine
// Animation, die startet, während sich das Layout oder der sichtbare Bereich
// noch ändert, landet daneben oder wird vom Browser abgebrochen.
//
// Wartet deshalb, bis das Ziel im DOM UND an seinem Platz ist. Cold-Open:
// toggleXxxCard öffnet die Karte, deren Lifecycle-Load aber async läuft und vom
// Toggle nicht awaited wird → bei $nextTick fehlt die erst nach dem Fetch
// gerenderte Listenzeile noch.
//
// „Im DOM" allein reicht nicht: im ersten Frame nach dem Einfügen steht die
// Zeile noch bei 0 und das Dokument ist kaum höher als das Fenster — ein Scroll
// dorthin ist dann ein No-op, und wenn die Liste danach fertig aufbaut, liegt
// das Ziel unbemerkt unterhalb des Bildes. Darum wird auf eine **stabile
// dokument-absolute Position** gewartet (zwei Frames gleich). Absolut gemessen,
// nicht relativ zum Fenster: der Wert ändert sich dann nur durch Layout, nicht
// durch einen laufenden Scroll.
//
// Zweite Bedingung: die Bildschirmtastatur. Kommt der Sprung aus einem
// Textfeld (Command-Palette, Suche), fährt die Tastatur nach dem Blur noch
// ~300 ms zu und vergrössert dabei den visualViewport. Ein Smooth-Scroll in
// dieser Zeit bricht Chrome auf Android ab oder verrechnet ihn. Gewartet wird,
// solange die Tastatur offen ist, aber kein Textfeld mehr den Fokus hält (sie
// fährt also gleich zu), und solange sich die Höhe des visualViewport ändert.
// Bleibt ein Textfeld fokussiert, bleibt die Tastatur offen — dann wird nicht
// auf sie gewartet.
//
// Dritte Bedingung: keine laufende Animation am Ziel oder darüber (siehe
// `_animating`).
//
// Bleibt etwas bis zum Ende des Budgets in Bewegung, wird trotzdem gescrollt —
// lieber ungenau als gar nicht. Ein neuer Aufruf verwirft einen noch wartenden
// älteren: sonst liefe der ältere Sprung nach dem neueren los.

// Ab dieser Differenz zwischen Fensterhöhe und sichtbarem Bereich gilt die
// Tastatur als offen (Adressleiste/Browser-UI liegen deutlich darunter).
const KEYBOARD_MIN_PX = 120;

let _seq = 0;

// Textfeld im Sinne der Bildschirmtastatur: es hält sie offen, solange es den
// Fokus hat.
export function isTextEntry(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return !el.readOnly;
  if (el.tagName === 'INPUT') {
    return !el.readOnly
      && !/^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/i.test(el.type || '');
  }
  return false;
}

function _keyboardOpen() {
  const vv = window.visualViewport;
  if (!vv) return false;
  // `* scale`: beim Pinch-Zoom schrumpft vv.height ohne Tastatur.
  return window.innerHeight - vv.height * vv.scale > KEYBOARD_MIN_PX;
}

function _keyboardClosing() {
  return _keyboardOpen() && !isTextEntry(document.activeElement);
}

// Läuft am Ziel oder einem Vorfahren eine endliche Animation (Karten-Eingang
// `cardFadeIn` schiebt per translateY)? Die gemessene Position enthält den
// Transform; ein Scroll jetzt landet um den Rest der Animation daneben.
// Endlose Animationen (Spinner) zählen nicht, sie enden nie.
function _animating(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const anims = n.getAnimations?.() || [];
    if (anims.some(a => a.playState === 'running'
      && a.effect?.getComputedTiming?.().endTime !== Infinity)) return true;
  }
  return false;
}

// Verwirft einen noch wartenden Sprung (z.B. weil der Aufrufer selbst sofort
// scrollt).
export function cancelPendingScroll() {
  _seq += 1;
}

// `target`: CSS-Selektor oder Funktion, die das Element liefert (oder null).
// `block`: wie scrollIntoView. `tries`: Frame-Budget (~1 s).
export function scrollToWhenReady(target, { block = 'center', tries = 60 } = {}) {
  const seq = ++_seq;
  let lastOffset = null;
  let lastVv = null;
  const find = typeof target === 'function' ? target : () => document.querySelector(target);
  const step = (left) => {
    if (seq !== _seq) return;
    const el = find();
    if (!el) {
      if (left > 0) requestAnimationFrame(() => step(left - 1));
      return;
    }
    const offset = Math.round(el.getBoundingClientRect().top + window.scrollY);
    const vvH = Math.round(window.visualViewport?.height ?? 0);
    const settling = offset !== lastOffset || vvH !== lastVv
      || _keyboardClosing() || _animating(el);
    lastOffset = offset;
    lastVv = vvH;
    if (settling && left > 0) {
      requestAnimationFrame(() => step(left - 1));
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block });
  };
  step(tries);
}

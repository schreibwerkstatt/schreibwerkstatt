// Kartenwechsel-Indikator: solange die Hauptansicht wechselt (Karte ↔ Karte,
// Karte → Editor), steht die alte Ansicht gedimmt und oben läuft ein schmaler
// Balken. Zustand: `$store.shell.viewSwitching`; Optik: `.layout-main.is-view-switching`
// in css/layout/twocolumn.css. DESIGN.md „Kartenwechsel: View Transition".
//
// Warum es das braucht: ein Kaltstart einer Karte (Partial holen, Alpine.initTree
// über ein paar hundert Knoten, Lade-Hook) dauert auf einem echten Gerät
// ~0,5–2 s. Die alte Ansicht bleibt in dieser Zeit absichtlich stehen (kein
// leerer Zwischen-Frame) — ohne Signal sieht das aus, als sei der Klick verpufft.
//
// Ablauf je Wechsel (`startViewSwitch` → Arbeit → `endViewSwitch`):
//  - Kalt (ein Partial ist noch nicht gemountet): Indikator SOFORT setzen und
//    einen Frame malen lassen, BEVOR die synchron blockierende Mount-Arbeit
//    beginnt. Ein Timer liefe sonst erst nach dem Block — zu spät.
//  - Warm: Indikator erst nach SHOW_DELAY_MS. Ein schneller Wechsel flackert nicht.
//  - Ende: `_withCardTransition` beendet ihn im selben Schritt, der die neue
//    Ansicht einschaltet — die neue Karte erscheint nie gedimmt. Steht der
//    Indikator schon, verzichtet der Helper auf den Cross-Fade (der friert das
//    Bild samt Spinner ein); sonst endet er IM Callback vor dem neuen Snapshot.
//
// Verhärtung:
//  - Token: jeder Wechsel bekommt eine Nummer; nur der jüngste darf beenden.
//    Ein überholter (langsamer) Wechsel löscht den Indikator des neuen nicht.
//  - Aufrufer beenden im `finally` — Fehler/Abbruch lassen nichts stehen.
//  - Deckel MAX_MS: hängt ein Await für immer (Netz weg), geht der Indikator
//    trotzdem aus; die alte Ansicht wird wieder bedienbar.
//  - `yieldToPaint` fällt per Timer durch, falls rAF nicht feuert (Tab im
//    Hintergrund) — der Wechsel hängt nie am Indikator.
//  - Ohne DOM/Store (Unit-Tests, native Schale) ist alles ein No-op.

export const SHOW_DELAY_MS = 150;
export const MAX_MS = 15000;
const PAINT_FALLBACK_MS = 100;

let seq = 0;
let showTimer = null;
let maxTimer = null;

function shell() {
  try { return globalThis.Alpine?.store?.('shell') || null; } catch { return null; }
}

function setSwitching(v) {
  const s = shell();
  if (s && s.viewSwitching !== v) s.viewSwitching = v;
}

function clearTimers() {
  clearTimeout(showTimer); showTimer = null;
  clearTimeout(maxTimer); maxTimer = null;
}

// Ist der Indikator gerade sichtbar? `_withCardTransition` verzichtet dann auf
// den Cross-Fade (der friert das Bild samt Spinner ein).
export function isViewSwitchVisible() {
  return !!shell()?.viewSwitching;
}

// Ist das Partial schon im DOM (warm)? Ohne DOM gilt alles als warm: dann gibt
// es nichts zu malen und auch keinen Grund, einen Frame abzuwarten.
export function isPartialMounted(name) {
  if (typeof document === 'undefined') return true;
  const el = document.getElementById(`partial-${name}`);
  return !el || el.childElementCount > 0;
}

export function beginViewSwitch({ immediate = false } = {}) {
  const token = ++seq;
  clearTimers();
  if (immediate) setSwitching(true);
  else showTimer = setTimeout(() => { if (token === seq) setSwitching(true); }, SHOW_DELAY_MS);
  maxTimer = setTimeout(() => endViewSwitch(token), MAX_MS);
  return token;
}

// Beendet nur den jüngsten Wechsel; ein überholter Token ist ein No-op.
// Mehrfach-Aufruf mit demselben Token ist erlaubt (Transition-Callback + finally).
export function endViewSwitch(token) {
  if (token == null || token !== seq) return;
  clearTimers();
  setSwitching(false);
}

// Einen Frame malen lassen: rAF feuert vor dem Paint, der Task danach läuft
// erst nach ihm. Timer-Fallback für versteckte Tabs (dort feuert rAF nicht).
export function yieldToPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(finish, 0));
    }
    setTimeout(finish, PAINT_FALLBACK_MS);
  });
}

// Wechsel beginnen: kalt, sobald eines der Partials fehlt. Liefert den Token,
// den der Aufrufer an `_withCardTransition` und ins `finally` weitergibt.
export async function startViewSwitch(partials = []) {
  const cold = partials.some(n => n && !isPartialMounted(n));
  const token = beginViewSwitch({ immediate: cold });
  if (cold) await yieldToPaint();
  return token;
}

// Nur für Tests: Modulzustand zurücksetzen.
export function _resetViewSwitchForTests() {
  clearTimers();
  seq = 0;
  setSwitching(false);
}

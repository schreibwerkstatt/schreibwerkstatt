// Schutz gegen verlorene `x-show`-Wechsel in Alpine (3.17.5).
//
// Alpine wendet ein `x-show` nicht sofort an: Einblenden läuft über
// `requestAnimationFrame`, Ausblenden über Microtask + `requestAnimationFrame`,
// und das Ausblenden liest sein `_x_hidePromise` erst beim Ausführen (und
// löscht es dabei). Kippt ein Flag innerhalb eines Frames `false → true → false`,
// laufen die Rückrufe als «ausblenden, einblenden, (nichts)»: das erste
// Ausblenden verbraucht das Promise des zweiten, das verspätete Einblenden
// zeigt das Element, das zweite Ausblenden findet kein Promise mehr. Ergebnis:
// Flag `false`, Element sichtbar — bis der nächste Wechsel es heilt.
//
// Ein Frame ist hier nicht 16 ms: Kartenwechsel laufen durch
// `_withCardTransition` (View Transition API), und solange deren Callback
// läuft, rendert der Browser nicht und `requestAnimationFrame` feuert nicht.
// So stand der Notebook-Editor leer offen neben einer frisch geöffneten Karte.
//
// Der Wrapper merkt sich beim Aufruf den zuletzt gewünschten Zustand am Element
// und lässt einen verspäteten Ein-/Ausblende-Rückruf nur laufen, wenn er noch
// zu diesem Zustand passt. Gilt für jedes `x-show` der App, mit und ohne
// `x-transition`/`x-collapse` (die rufen dieselben Rückrufe).
//
// Nicht abgedeckt (und hier nicht abdeckbar): ein Flag-Wechsel, den Alpines
// Scheduler gar nicht erst an x-show weiterreicht — dafür der Scheduler-Patch im
// Vendor-Alpine, docs/architektur.md#alpine-scheduler-patch.
//
// Muss im `alpine:init`-Listener laufen: dann ist die Prototyp-Methode
// definiert, aber noch kein `x-show` ausgewertet. Fehlt die Methode (anderes
// Alpine-Release), bleibt alles beim Alten — der E2E-Test
// tests/e2e-app/x-show-guard.spec.js wird dann rot.

const WANT = '_x_showWanted';

export function installXShowGuard(proto = globalThis.Element?.prototype) {
  const orig = proto?._x_toggleAndCascadeWithTransitions;
  if (typeof orig !== 'function') return false;
  if (orig.__xShowGuard) return true;
  const guarded = function (el, value, show, hide) {
    const want = !!value;
    el[WANT] = want;
    const onShow = () => { if (el[WANT] === true) show(); };
    const onHide = () => { if (el[WANT] === false) hide(); };
    return orig.call(this, el, value, onShow, onHide);
  };
  guarded.__xShowGuard = true;
  proto._x_toggleAndCascadeWithTransitions = guarded;
  return true;
}

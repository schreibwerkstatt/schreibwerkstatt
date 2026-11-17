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
// Zweites Loch, gleiche Wirkung: das Ausblenden eines Vorfahren wartet auf das
// seiner Nachfahren. Blendet ein Kind mit Transition im selben Zug aus wie ein
// Vorfahr, hängt Alpine es an dessen `_x_hideChildren`, und der Vorfahr blendet
// erst aus, wenn `Promise.all` über alle Hide-Promises erfüllt ist. Zwei Wege,
// auf denen das nie geschieht:
//  - `x-collapse` reicht den Fertig-Rückruf nicht weiter (sein `out()` ignoriert
//    sein `after`-Argument und blendet sich selbst aus): das Hide-Promise eines
//    zuklappenden Panels bleibt für immer offen.
//  - Eine abgebrochene Leave-Transition (das Kind wird wieder eingeblendet)
//    lehnt ihr Hide-Promise mit `isFromCancelledTransition` ab.
// So stand der Notebook-Editor (Klapp-Panel der Revisionsliste darin) leer
// neben der Hilfe. Der Wrapper erfüllt das Promise eines `x-collapse`-Panels
// darum sofort mit «nichts tun» — es klappt sich selbst zu, und der Vorfahr
// wartet nicht auf die Animation (sonst stünde die Karte so lange sichtbar
// neben der nächsten). Bei `x-transition` bleibt Alpines Warten (der Vorfahr
// blendet nach der Leave-Animation des Kinds aus); ein Abbruch wird dort zu
// «für dieses Element nichts tun».
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
    const ret = orig.call(this, el, value, onShow, onHide);
    if (!want) settleHidePromise(el);
    return ret;
  };
  guarded.__xShowGuard = true;
  proto._x_toggleAndCascadeWithTransitions = guarded;
  return true;
}

// `_x_hidePromise` setzt Alpine synchron im Toggle; gelesen wird es erst im
// Microtask/Frame danach — der Austausch hier kommt also rechtzeitig.
// `x-collapse` erkennt man an einem `_x_transition` ohne `enter`/`leave`
// (das von `x-transition` trägt beide).
const NOOP = () => {};
function settleHidePromise(el) {
  const p = el._x_hidePromise;
  if (!p || typeof p.then !== 'function') return;
  const t = el._x_transition;
  if (t && !t.enter && !t.leave) {
    // Das ersetzte Promise lehnt bei einem Abbruch noch ab — ohne Abnehmer
    // wäre das eine unbehandelte Ablehnung.
    p.catch(NOOP);
    el._x_hidePromise = Promise.resolve(NOOP);
    return;
  }
  el._x_hidePromise = p.catch((e) => {
    if (e && e.isFromCancelledTransition) return NOOP;
    throw e;
  });
}

// Tab-übergreifende Editier-Sperre für das Einspielen einer neuen SW-Generation.
//
// DAS PROBLEM: `skip-waiting` wechselt den Service Worker für ALLE Tabs der
// Origin, nicht nur für den, der die Nachricht schickt — und `activate` wirft
// die alte Generation weg. Prüft der aktivierende Tab nur seinen eigenen
// Editier-Zustand, zieht er einem anderen Tab, der gerade schreibt, die
// Generation unter den Füssen weg: dessen geladene Module bleiben alt, jedes
// nachgeladene Partial/Modul kommt ab da aus der neuen (Skew → ReferenceError).
// Typische Auslöser: Tab A liegt im Hintergrund (Auto-Apply), während in Tab B
// editiert wird; oder man öffnet während des Schreibens einen zweiten Tab
// (Boot-Pfad aktiviert sofort).
//
// DIE ANTWORT: Web Locks. Jeder Tab, der gerade editiert, hält den Lock
// BUSY_LOCK geteilt (`shared`); aktiviert wird nur, wer ihn exklusiv und ohne
// Warten (`ifAvailable`) bekommt — also nur, wenn KEIN Tab editiert. Ein Lock
// fällt mit seinem Tab (auch beim Absturz), es bleibt nichts hängen.
//
// Ohne Web Locks (sehr alte Browser) gilt der Zustand des eigenen Tabs allein.
//
// `locks` ist injizierbar, damit die Logik ohne Browser prüfbar bleibt
// (tests/unit/busy-lock.test.mjs).

export const BUSY_LOCK = 'schreibwerkstatt-sw-busy';

function defaultLocks() {
  return (typeof navigator !== 'undefined' && navigator.locks) || null;
}

// Hält den geteilten Lock, solange `isBusy()` wahr ist. `sync()` nach jeder
// möglichen Zustandsänderung aufrufen (Intervall + Eingabe-Events); es ist
// idempotent und billig.
export function createBusyLock({ isBusy, locks = defaultLocks() } = {}) {
  let release = null;   // resolve-Funktion des gehaltenen Locks
  let acquiring = false;

  function sync() {
    if (!locks) return;
    const busy = !!isBusy();
    if (busy && !release && !acquiring) {
      acquiring = true;
      locks.request(BUSY_LOCK, { mode: 'shared' }, () => new Promise((resolve) => {
        acquiring = false;
        release = resolve;
        // Zustand kann sich während des Wartens auf den Lock geändert haben.
        if (!isBusy()) { release = null; resolve(); }
      })).catch(() => { acquiring = false; release = null; });
    } else if (!busy && release) {
      const r = release;
      release = null;
      r();
    }
  }

  return { sync, get held() { return !!release; } };
}

// Führt `activate()` nur aus, wenn gerade kein Tab editiert. Liefert, ob
// aktiviert wurde. Der eigene Tab muss vorher `sync()` gelaufen sein — hält er
// selbst den geteilten Lock, bekommt er den exklusiven ebenfalls nicht.
export async function activateIfNobodyBusy(activate, { locks = defaultLocks() } = {}) {
  if (!locks) return !!activate();
  try {
    return await locks.request(BUSY_LOCK, { mode: 'exclusive', ifAvailable: true },
      (lock) => (lock ? !!activate() : false));
  } catch {
    return false;
  }
}

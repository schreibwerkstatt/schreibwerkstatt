// Wann eine neue Shell-Generation eingespielt wird — pure Entscheidungen, damit
// sie ohne Browser prüfbar sind (tests/unit/update-policy.test.mjs). Die
// Mechanik (skip-waiting, controllerchange-Reload) liegt in sw-register.js.
//
// DAS PROBLEM: Der neue SW bleibt `waiting`, bis ihn jemand aktiviert — ein
// Reload reicht nicht, weil der alte SW die Seite über den Reload hinweg
// weiter kontrolliert, und auch ein neuer Tab bekommt die alte Generation,
// solange irgendein Tab offen ist. Ohne automatisches Aktivieren bleibt, wer
// das Banner übersieht, beliebig lange auf der alten Version.
//
// DIE ANTWORT: aktivieren, sobald nichts verloren gehen kann —
//   • beim Boot (es wurde noch nichts getippt),
//   • wenn der Tab im Hintergrund liegt oder AUTO_APPLY_IDLE_MS ohne Eingabe war.
// Wer editiert (Edit-/Fokusmodus, ungespeicherte Änderungen, auch im
// Bucheditor), bekommt das Banner — und zwar in JEDEM Tab: skip-waiting wirkt
// origin-weit, die Sperre über alle Tabs liegt in busy-lock.js.
// Ein Pflicht-Update (shell-protocol.js) wartet nur noch auf ungespeicherte
// Änderungen, nicht mehr auf den Edit- oder Fokusmodus selbst.

export const AUTO_APPLY_IDLE_MS = 120_000;
export const AUTO_APPLY_TICK_MS = 15_000;

// Weitere Editier-Zustände ausserhalb der Root: der Bucheditor führt seinen
// eigenen Block-Zustand (dirty/saving) und trägt sich hier ein
// (cards/book-editor-card.js). Rückgabe: Abmelde-Funktion.
const busySources = new Set();
export function registerBusySource(fn) {
  busySources.add(fn);
  return () => busySources.delete(fn);
}

// Editier-Zustand: editDirty allein reicht nicht, Auto-Save flippt ihn
// zwischendurch auf false — editMode/focusActive sind das härtere Signal.
// Notebook- und Focus-Editor über die Root-Felder, der Bucheditor über seine
// registrierte Quelle.
export function isBusy(app) {
  if (app?.editMode || app?.focusActive || app?.editDirty) return true;
  for (const fn of busySources) {
    try { if (fn()) return true; } catch {}
  }
  return false;
}

export function shouldAutoApply({ hidden, idleMs, busy, online }) {
  if (busy || !online) return false;
  return !!hidden || idleMs >= AUTO_APPLY_IDLE_MS;
}

export function isUpdateRequired(serverProtocol, clientProtocol) {
  const s = Number(serverProtocol);
  const c = Number(clientProtocol);
  return Number.isFinite(s) && Number.isFinite(c) && s > c;
}

export function shouldForceUpdate({ dirty, online }) {
  return !dirty && !!online;
}

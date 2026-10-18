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
//   • in einem Tab, der mit einer veralteten Shell gebootet hat (`staleBoot`:
//     das Update tauchte erst kurz nach dem Laden auf — ein neuer Tab nach
//     einem Deploy wird vom alten SW bedient, und dessen Nachfolger installiert
//     erst, wenn der Tab schon läuft),
//   • wenn der Tab im Hintergrund liegt oder AUTO_APPLY_IDLE_MS ohne Eingabe war.
// Wer editiert (Edit-/Fokusmodus, ungespeicherte Änderungen, auch im
// Bucheditor), bekommt das Banner — und zwar in JEDEM Tab: skip-waiting wirkt
// origin-weit, die Sperre über alle Tabs liegt in busy-lock.js.
// Wechselt die Generation trotzdem, während dieser Tab editiert, ist er
// ab da schief (neue Partials gegen alte Module) und wird nachgeräumt, sobald
// das Editieren endet — `shouldHealSkew` unten.
// Ein Pflicht-Update (shell-protocol.js) wartet nur noch auf ungespeicherte
// Änderungen (`hasUnsavedWork`, alle Editoren), nicht mehr auf den Edit- oder
// Fokusmodus selbst — und wird wiederholt geprüft, bis eine Antwort da ist
// (`shouldCheckProtocol`).

export const AUTO_APPLY_IDLE_MS = 120_000;
export const AUTO_APPLY_TICK_MS = 15_000;
// Taucht ein Update so kurz nach dem Laden auf, hat dieser Tab die alte Shell
// gebootet — er gilt als `staleBoot` und wartet nicht auf den Leerlauf.
export const BOOT_STALE_WINDOW_MS = 30_000;

// Weitere Editier-Zustände ausserhalb der Root: der Bucheditor führt seinen
// eigenen Block-Zustand (dirty/saving) und trägt sich hier ein
// (cards/book-editor-card.js). Rückgabe: Abmelde-Funktion. Eine Quelle meldet
// ungespeicherte Arbeit — sie zählt für `isBusy` UND `hasUnsavedWork`.
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

// Ungespeicherte Arbeit, die ein Reload verlöre — die Schwelle des
// Pflicht-Updates. Enger als `isBusy` (Edit-/Fokusmodus allein zählt nicht),
// aber über ALLE Editoren: der Bucheditor hat keine lokalen Entwürfe, seine
// ungespeicherten Blöcke wären nach dem Reload weg. `editSaving`: ein PUT ist
// unterwegs, ein Reload machte daraus eine verlorene Save-Antwort.
export function hasUnsavedWork(app) {
  if (app?.editDirty || app?.editSaving) return true;
  for (const fn of busySources) {
    try { if (fn()) return true; } catch {}
  }
  return false;
}

export function shouldAutoApply({ hidden, idleMs, busy, online, staleBoot = false }) {
  if (busy || !online) return false;
  return !!hidden || !!staleBoot || idleMs >= AUTO_APPLY_IDLE_MS;
}

export function isUpdateRequired(serverProtocol, clientProtocol) {
  const s = Number(serverProtocol);
  const c = Number(clientProtocol);
  return Number.isFinite(s) && Number.isFinite(c) && s > c;
}

export function shouldForceUpdate({ dirty, online }) {
  return !dirty && !!online;
}

// Wann die Shell erneut gegen ein frisches `/config.shellProtocol` prüft.
// Ein einzelner Abruf beim neu installierten SW reicht nicht: scheitert er
// (Netz-Wackler, Aufwachen), bleibt ein editierender Tab auf der alten Shell —
// die normale Update-Politik wartet auf `isBusy`, und ein Tab, der den
// Generationswechsel schief erlebt hat, hat gar keinen wartenden SW mehr.
// `pending` steht darum ab `updatefound` bzw. dem schiefen `controllerchange`,
// bis eine Prüfung eine gültige Antwort bekam, und wird im Auto-Apply-Takt
// wiederholt. Beim Aufwachen wird zusätzlich geprüft — gedrosselt, damit
// Tab-Wechsel nichts kosten.
export const PROTOCOL_WAKE_MIN_MS = 30_000;

export function shouldCheckProtocol({ pending, inflight, online, wake = false, sinceLastMs = Infinity }) {
  if (inflight || !online) return false;
  if (pending) return true;
  return !!wake && sinceLastMs >= PROTOCOL_WAKE_MIN_MS;
}

// Skew-Heilung. Nach einem `controllerchange` ohne Reload (Tab war busy oder
// offline) kontrolliert der NEUE Service Worker ein Dokument, dessen Module
// noch ALTE sind: jeder ab da lazy nachgeladene Partial wird gegen die alte
// Card ausgewertet und wirft `ReferenceError` auf Felder, die erst der neue
// Build kennt (`splitLink`, `bubbleMsgUnwrapOk` …). Das Banner allein heilt
// nichts — es wartet auf einen Klick, den der User nicht kennt. Stattdessen:
// den Reload nachholen, sobald er gefahrlos ist, also weder beim Editieren
// noch offline. `reloaded` sperrt den zweiten Versuch (der Reload ist der Fix;
// ein weiterer Versuch in derselben Sitzung bräuchte eine neue Generation).
export function shouldHealSkew({ skewed, reloaded, busy, online }) {
  return !!skewed && !reloaded && !busy && !!online;
}

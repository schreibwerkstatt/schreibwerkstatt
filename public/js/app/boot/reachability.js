// Erreichbarkeit des Servers — der eine Ort für «sind wir offline?».
//
// `navigator.onLine` meldet nur, ob eine Netzschnittstelle steht, nicht ob der
// Server antwortet. Hotspot ohne erreichbaren DNS, Captive Portal, Zug im
// Tunnel: der Browser sagt „online", jeder Request hängt bis zum Timeout. Auf
// Prod meldeten 8 von 9 Save-Ausfällen mit Netzfehler `online=true`.
//
// Darum zwei Quellen in EINEM Zustand:
//   - `navigator.onLine === false` → sofort offline (wie bisher),
//   - Server als unerreichbar erkannt → ebenfalls offline.
// `isOffline()` ist die Abfrage für alle Gates (Banner, `is-offline`-Dimmung,
// net-required-Riegel, Offline-Buch-Sync, Offline-Suche, Update-Reload).
//
// SIGNALE (wer meldet was):
//   - fetch-guard.js: Netzfehler/Timeout jedes eigenen Requests; Erfolg nur
//     für Antworten, die sicher vom Netz kamen (Schreib-Requests, oder kein SW).
//   - sw.js (`net-status`-Nachricht): Erfolg/Fehler/„langsam" seiner eigenen
//     Netz-Fetches — er sieht auch die Hintergrund-Abgleiche hinter einem
//     Cache-Treffer, die die Seite nie zu Gesicht bekommt.
//   - Job-Queue-Poll: jede Antwort ist ein Erfolg.
//   - Test (`probeServer`): `GET /ping`, solange unerreichbar.
//
// EINSTIEG schnell, AUSSTIEG sofort: ein Timeout oder „langsam" (GET ohne
// Antwort nach SLOW_MS) schaltet sofort um, gewöhnliche Netzfehler ab dem
// zweiten innert FAIL_WINDOW_MS. Die erste echte Server-Antwort — auch 401/404/
// 409 — schaltet zurück. Ein Fehlalarm kostet so Sekunden; ein übersehener
// Ausfall kostete bis zu 30 s je Klick.
//
// Hintergrund-Tab: der Browser friert dort Verbindungen ein, die ersten
// Fetches beim Aufwachen scheitern. Fehler aus einem versteckten Tab zählen
// darum nicht.
//
// Saves laufen NICHT über `isOffline()` — dort entscheidet der Versuch selbst,
// und ein gelungener Save schaltet über fetch-guard zurück.
import { EVT } from '../../events.js';

export const SLOW_MS = 10_000;
export const FAIL_WINDOW_MS = 20_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_MIN_MS = 5_000;
export const PROBE_MAX_MS = 60_000;
export const PING_PATH = '/ping';
// Inhalt der /ping-Antwort. Ein Captive Portal, das jede URL mit seiner Seite
// beantwortet, liefert das nicht — ohne den Abgleich gälte es als „erreichbar".
export const PING_APP = 'schreibwerkstatt';

// Fehlerarten, die sofort umschalten (eine Antwort blieb aus, statt abgewiesen).
const IMMEDIATE = new Set(['slow', 'timeout']);

const state = {
  unreachable: false,
  since: 0,
  fails: [],
  probeTimer: null,
  probeDelay: 0,
  probing: null,
};

// Ungeschütztes fetch für den Test: der globale Wrapper (fetch-guard.js) würde
// einen 401 als Session-Ablauf melden und den Test selbst als Signal zählen.
let rawFetch = null;
export function setRawFetch(fn) { rawFetch = fn; }

function browserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function hidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function isServerUnreachable() { return state.unreachable; }

/** Browser offline ODER Server als unerreichbar erkannt. */
export function isOffline() { return browserOffline() || state.unreachable; }

function emit() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVT.REACHABILITY, { detail: { unreachable: state.unreachable } }));
}

function tellServiceWorker() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'reachability', unreachable: state.unreachable });
  } catch { /* ohne SW nichts zu sagen */ }
}

function setUnreachable(v, now) {
  if (state.unreachable === v) return;
  state.unreachable = v;
  state.since = v ? now : 0;
  state.fails = [];
  if (v) scheduleProbe(true);
  else stopProbe();
  tellServiceWorker();
  emit();
}

/** Echte Server-Antwort gesehen. */
export function noteServerOk(now = Date.now()) {
  state.fails = [];
  setUnreachable(false, now);
}

/**
 * Netz-Fehlschlag. `kind`: 'network' (Request scheiterte), 'proxy' (502/504),
 * 'timeout' (Aufrufer-Timeout), 'slow' (GET ohne Antwort nach SLOW_MS).
 */
export function noteServerFail(kind = 'network', now = Date.now()) {
  if (state.unreachable || browserOffline() || hidden()) return;
  if (IMMEDIATE.has(kind)) { setUnreachable(true, now); return; }
  state.fails = state.fails.filter((t) => now - t < FAIL_WINDOW_MS);
  state.fails.push(now);
  if (state.fails.length >= 2) setUnreachable(true, now);
}

/** Antwortet der Server? Ergebnis setzt den Zustand. Parallele Aufrufe teilen einen Test. */
export function probeServer({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (state.probing) return state.probing;
  const fetchFn = rawFetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return Promise.resolve(!state.unreachable);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  state.probing = (async () => {
    try {
      const res = await fetchFn(PING_PATH, { cache: 'no-store', credentials: 'same-origin', signal: ctrl?.signal });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body?.app === PING_APP) { noteServerOk(); return true; }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      state.probing = null;
    }
  })();
  return state.probing;
}

function stopProbe() {
  clearTimeout(state.probeTimer);
  state.probeTimer = null;
  state.probeDelay = 0;
}

function scheduleProbe(reset = false) {
  clearTimeout(state.probeTimer);
  state.probeDelay = reset || !state.probeDelay ? PROBE_MIN_MS : Math.min(PROBE_MAX_MS, state.probeDelay * 2);
  state.probeTimer = setTimeout(async () => {
    state.probeTimer = null;
    if (!state.unreachable) return;
    const ok = await probeServer();
    if (!ok && state.unreachable) scheduleProbe();
  }, state.probeDelay);
}

// Anlässe für einen sofortigen Test: Tab wieder sichtbar/fokussiert, Netz-
// schnittstelle zurück. Einmal beim Boot (fetch-guard.js).
let installed = false;
export function installReachability() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const now = () => { if (state.unreachable) probeServer().then((ok) => { if (!ok && state.unreachable) scheduleProbe(true); }); };
  window.addEventListener('online', now);
  window.addEventListener('focus', now);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) now(); });
  window.addEventListener('offline', emit);
  window.addEventListener('online', emit);
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    const d = e.data;
    if (d?.type !== 'net-status') return;
    if (d.status === 'ok') noteServerOk();
    else noteServerFail(d.status === 'slow' ? 'slow' : 'network');
  });
  // Neuer Controller kennt den Zustand nicht.
  navigator.serviceWorker?.addEventListener?.('controllerchange', tellServiceWorker);
}

/**
 * `fn` bei jedem Wechsel des Offline-Zustands (Browser oder Server).
 * Ersetzt das Paar `online`/`offline`-Listener.
 */
export function onConnectivityChange(fn, { signal } = {}) {
  window.addEventListener('online', fn, { signal });
  window.addEventListener('offline', fn, { signal });
  window.addEventListener(EVT.REACHABILITY, fn, { signal });
}

/**
 * `fn`, sobald die Verbindung zurück ist: Browser-`online` ODER Server wieder
 * erreichbar. Ersetzt `window.addEventListener('online', …)` für Nachhol-Pfade.
 * Mit `once` feuert `fn` höchstens einmal; die Rückgabe löst die Bindung.
 */
export function onReconnect(fn, { signal, once = false } = {}) {
  let done = false;
  const onReach = (e) => { if (!e.detail?.unreachable) fire(); };
  const off = () => {
    window.removeEventListener('online', fire);
    window.removeEventListener(EVT.REACHABILITY, onReach);
  };
  function fire() {
    if (done) return;
    if (browserOffline() || state.unreachable) return;
    if (once) { done = true; off(); }
    fn();
  }
  window.addEventListener('online', fire, { signal });
  window.addEventListener(EVT.REACHABILITY, onReach, { signal });
  return off;
}

// Nur für Tests.
export function _resetReachability() {
  stopProbe();
  state.unreachable = false;
  state.since = 0;
  state.fails = [];
  state.probing = null;
}

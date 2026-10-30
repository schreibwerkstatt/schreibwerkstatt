// Signal «hier sitzt gerade jemand» für den Aktivitätszähler des Servers
// (lib/user-activity.js). Der fetch-Wrapper hängt `X-User-Active: 1` an
// Requests ans eigene Origin, solange der Tab sichtbar ist und die letzte
// bewusste Eingabe weniger als ACTIVE_WINDOW_MS zurückliegt. Hintergrund-Polls
// eines vergessenen Tabs tragen den Header nicht und zählen darum nicht.

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'input'];
export const USER_ACTIVE_HEADER = 'X-User-Active';

let _lastInputAt = Date.now();

export function installUserActiveTracker() {
  const mark = () => { _lastInputAt = Date.now(); };
  for (const ev of ACTIVITY_EVENTS) {
    document.addEventListener(ev, mark, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') mark();
  });
}

export function isUserActive(now = Date.now(), lastInputAt = _lastInputAt,
  visible = document.visibilityState === 'visible') {
  return visible && now - lastInputAt < ACTIVE_WINDOW_MS;
}

function _sameOrigin(input) {
  if (typeof input !== 'string' && !(input instanceof URL)) return false;
  try { return new URL(String(input), location.href).origin === location.origin; }
  catch { return false; }
}

/** Liefert `init` mit Aktivitäts-Header, wenn er dazugehört, sonst unverändert. */
export function withUserActiveHeader(input, init) {
  if (!_sameOrigin(input) || !isUserActive()) return init;
  const headers = new Headers(init?.headers || undefined);
  headers.set(USER_ACTIVE_HEADER, '1');
  return { ...(init || {}), headers };
}

// Server-pflichtige Requests ohne Verbindung sofort abweisen, statt sie in den
// Timeout laufen zu lassen.
//
// KI-Jobs, Diktat, Vorlesen, LanguageTool und die Suche rechnen auf dem Server;
// einen Offline-Ersatz gibt es (ausser der Suche über offline abgelegte
// Abschnitte, cards/search-card.js) nicht. Ohne diesen Riegel wartet ein Klick
// je nach Pfad bis zum Fetch-Timeout und endet in einer generischen
// Netzwerk-Meldung. Mit ihm scheitert der Request sofort wie ein Netzfehler
// (`TypeError`, Feld `offline: true`) — jeder Aufrufer behandelt das schon —,
// und für ausdrückliche Aktionen (Job starten, Diktat, Vorlesen) meldet die
// App einmal, warum (EVT.NET_REQUIRED → Toast, app-offline-books.js).
//
// Gate ist ausschliesslich `navigator.onLine === false`. Der Wert kann falsch
// „online" sagen (dann läuft der Request wie bisher ins Netz) und selten falsch
// „offline" (VPN-/Interface-Flap) — dann zeigt auch das Offline-Banner es an.
// Save-Pfade laufen bewusst NICHT hierüber: dort entscheidet der Versuch selbst
// (editor/notebook/edit/lifecycle.js).
import { EVT } from '../../events.js';

// method: '*' = jede Methode. `announce`: der User hat ausdrücklich etwas
// ausgelöst → einmal melden. Automatische Requests (LanguageTool beim Tippen,
// Such-Debounce, Semantik-Status) bleiben stumm.
const RULES = [
  { re: /^\/jobs\//, method: 'POST', announce: true },
  { re: /^\/stt\//, method: '*', announce: true },
  { re: /^\/tts\//, method: '*', announce: true },
  { re: /^\/languagetool\/check$/, method: '*', announce: false },
  { re: /^\/search(?:\/|$)/, method: '*', announce: false },
];

function _urlAndMethod(input, init) {
  let url;
  let method = init?.method;
  if (typeof input === 'string' || input instanceof URL) url = String(input);
  else if (input && typeof input.url === 'string') { url = input.url; method = method || input.method; }
  else return null;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const u = new URL(url, base);
    if (typeof location !== 'undefined' && u.origin !== location.origin) return null;
    return { path: u.pathname, method: String(method || 'GET').toUpperCase() };
  } catch { return null; }
}

// Regel für einen Request oder null. Rein, für Tests exportiert.
export function netRequiredRule(input, init) {
  const um = _urlAndMethod(input, init);
  if (!um) return null;
  return RULES.find((r) => r.re.test(um.path) && (r.method === '*' || r.method === um.method)) || null;
}

export function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function offlineError() {
  const e = new TypeError('offline');
  e.offline = true;
  return e;
}

export function isOfflineRejection(e) {
  return !!e?.offline;
}

// Vor dem eigentlichen fetch: wirft, wenn der Request ohne Netz sinnlos ist.
export function guardNetRequired(input, init) {
  if (!isBrowserOffline()) return;
  const rule = netRequiredRule(input, init);
  if (!rule) return;
  if (rule.announce && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVT.NET_REQUIRED));
  }
  throw offlineError();
}

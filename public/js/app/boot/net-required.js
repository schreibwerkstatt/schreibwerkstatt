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
// Zwei Lagen (reachability.js):
//   - Browser offline (`navigator.onLine === false`): sofort abweisen.
//   - Server als unerreichbar erkannt: das kann ein Fehlalarm sein. Für eine
//     ausdrückliche Aktion darum erst kurz testen (`probeServer`, ≤ 3 s);
//     antwortet er, läuft die Aktion normal. Automatische Requests (LT beim
//     Tippen, Such-Debounce) werden ohne Test abgewiesen.
// Save-Pfade laufen bewusst NICHT hierüber: dort entscheidet der Versuch selbst
// (editor/notebook/edit/lifecycle.js).
import { EVT } from '../../events.js';
import { isServerUnreachable, probeServer } from './reachability.js';

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

function _reject(rule) {
  if (rule.announce && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVT.NET_REQUIRED));
  }
  throw offlineError();
}

// Vor dem eigentlichen fetch. Browser offline: wirft synchron. Server als
// unerreichbar erkannt: automatische Requests werfen synchron, ausdrückliche
// Aktionen bekommen ein Promise (Test), das auflöst (weiter) oder wirft.
// Sonst `undefined`.
export function guardNetRequired(input, init) {
  const browser = isBrowserOffline();
  if (!browser && !isServerUnreachable()) return undefined;
  const rule = netRequiredRule(input, init);
  if (!rule) return undefined;
  if (browser || !rule.announce) _reject(rule);
  return probeServer().then((ok) => { if (!ok) _reject(rule); });
}

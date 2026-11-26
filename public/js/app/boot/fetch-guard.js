import { EVT } from '../../events.js';
import { guardNetRequired, isOfflineRejection } from './net-required.js';
import { installUserActiveTracker, withUserActiveHeader } from './user-active.js';
import { withTabHeader } from './tab-header.js';
import { installReachability, noteServerFail, noteServerOk, setRawFetch, SLOW_MS } from './reachability.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via SESSION_EXPIRED-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
// Ohne Verbindung weist er Server-pflichtige Requests sofort ab (net-required.js).
// Bei bewusster Nutzung trägt er das Aktivitäts-Signal mit (user-active.js),
// an Schreib-Requests die Tab-Kennung (tab-header.js, Live-Echo).
// Und er meldet der Erreichbarkeit (reachability.js), was er von eigenen
// Requests sieht — siehe `observe`.
export function installFetchGuard() {
  const origFetch = window.fetch.bind(window);
  setRawFetch(origFetch);
  installReachability();
  installUserActiveTracker();
  window.fetch = async function(input, init, ...rest) {
    const gate = guardNetRequired(input, init);
    if (gate) await gate;
    const seen = observe(input, init);
    let res;
    try {
      res = await origFetch(input, withTabHeader(input, withUserActiveHeader(input, init)), ...rest);
    } catch (e) {
      seen?.failed(e);
      throw e;
    }
    seen?.answered(res);
    if (res.status === 401 && !window.__sessionExpiredNotified) {
      window.__sessionExpiredNotified = true;
      window.dispatchEvent(new CustomEvent(EVT.SESSION_EXPIRED));
    }
    return res;
  };
}

// Was ein Request über die Erreichbarkeit verrät. Nur eigene Origin.
//  - Netzfehler → 'network', Aufrufer-Timeout (TimeoutError) → 'timeout'.
//    Ein Abbruch durch den Aufrufer (AbortError) und die Abweisung des
//    net-required-Riegels sagen nichts über den Server.
//  - GET ohne Antwort nach SLOW_MS → 'slow'. Nur GET: ein Upload/Save auf
//    schwachem Netz darf länger brauchen, ohne Fehlalarm.
//  - 502/504 → 'proxy' (Reverse-Proxy erreicht, App dahinter nicht).
//  - Erfolg zählt nur, wenn die Antwort sicher vom Netz kam: der SW bedient
//    GETs auch aus dem Cache, ohne dass es der Antwort anzusehen wäre — für
//    seine GETs meldet er selbst (`net-status`, sw.js). Schreib-Requests
//    laufen nie über ihn.
export function classifyRequest(input, init, { controlled = false, origin } = {}) {
  let url; let method = init?.method;
  try {
    if (typeof input === 'string' || input instanceof URL) url = new URL(String(input), origin);
    else if (input && typeof input.url === 'string') { url = new URL(input.url, origin); method = method || input.method; }
    else return null;
  } catch { return null; }
  if (url.origin !== new URL(origin).origin) return null;
  const isGet = String(method || 'GET').toUpperCase() === 'GET';
  return { isGet, countsOk: !isGet || !controlled };
}

export function failKind(e) {
  if (!e || isOfflineRejection(e)) return null;
  if (e.name === 'TimeoutError') return 'timeout';
  if (e.name === 'AbortError') return null;
  if (e.name === 'TypeError') return 'network';
  return null;
}

function observe(input, init) {
  const info = classifyRequest(input, init, {
    controlled: !!navigator.serviceWorker?.controller,
    origin: location.href,
  });
  if (!info) return null;
  const slow = info.isGet ? setTimeout(() => noteServerFail('slow'), SLOW_MS) : null;
  return {
    failed(e) {
      clearTimeout(slow);
      const kind = failKind(e);
      if (kind) noteServerFail(kind);
    },
    answered(res) {
      clearTimeout(slow);
      if (res.status === 502 || res.status === 504) { noteServerFail('proxy'); return; }
      if (info.countsOk) noteServerOk();
    },
  };
}

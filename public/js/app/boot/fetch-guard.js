import { EVT } from '../../events.js';
import { guardNetRequired } from './net-required.js';
import { installUserActiveTracker, withUserActiveHeader } from './user-active.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via SESSION_EXPIRED-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
// Ohne Verbindung weist er Server-pflichtige Requests sofort ab (net-required.js).
// Bei bewusster Nutzung trägt er das Aktivitäts-Signal mit (user-active.js).
export function installFetchGuard() {
  const origFetch = window.fetch.bind(window);
  installUserActiveTracker();
  window.fetch = async function(input, init, ...rest) {
    guardNetRequired(input, init);
    const res = await origFetch(input, withUserActiveHeader(input, init), ...rest);
    if (res.status === 401 && !window.__sessionExpiredNotified) {
      window.__sessionExpiredNotified = true;
      window.dispatchEvent(new CustomEvent(EVT.SESSION_EXPIRED));
    }
    return res;
  };
}

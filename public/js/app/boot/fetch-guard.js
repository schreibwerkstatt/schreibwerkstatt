import { EVT } from '../../events.js';
import { guardNetRequired } from './net-required.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via SESSION_EXPIRED-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
// Ohne Verbindung weist er Server-pflichtige Requests sofort ab (net-required.js).
export function installFetchGuard() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    guardNetRequired(args[0], args[1]);
    const res = await origFetch(...args);
    if (res.status === 401 && !window.__sessionExpiredNotified) {
      window.__sessionExpiredNotified = true;
      window.dispatchEvent(new CustomEvent(EVT.SESSION_EXPIRED));
    }
    return res;
  };
}

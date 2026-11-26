// Tab-Kanal: Schreibvorgänge am Manuskript an die anderen Tabs DESSELBEN
// Browsers melden (BroadcastChannel). Server-Anstoss und /changes filtern das
// eigene Gerät heraus (eine Device-ID pro Browser-Profil, device-id.js) — ein
// Save in Tab A erreichte Tab B sonst erst beim Neuladen. Andere Geräte und
// User laufen weiter über den Event-Stream (event-stream.js).
//
// Ereignisse (vom Repo gesendet, repo/content.js):
//   { type: 'page-saved', bookId, pageId, pageName }  Body geschrieben
//   { type: 'structure', bookId }                      Baum geändert
// Konsument: app/app-collab-stream.js#_onTabEvent — behandelt sie wie einen
// fremden Write vom eigenen Gerät („anderer Tab").

const CHANNEL = 'sw-tab-events';
let chan;
const listeners = new Set();

function _chan() {
  if (chan !== undefined) return chan;
  chan = null;
  if (typeof BroadcastChannel === 'undefined') return chan;
  try {
    chan = new BroadcastChannel(CHANNEL);
    // Node (Unit-Tests über repo/content.js) hält den Prozess sonst offen.
    chan.unref?.();
    chan.onmessage = (e) => { for (const cb of [...listeners]) { try { cb(e.data); } catch { /* Konsument */ } } };
  } catch { chan = null; }
  return chan;
}

export function postTabEvent(ev) {
  try { _chan()?.postMessage(ev); } catch { /* nicht klonbar / geschlossen */ }
}

// Liefert die Abmelde-Funktion. Eigene Nachrichten kommen nie zurück
// (BroadcastChannel stellt nicht an den Sender zu).
export function onTabEvent(cb) {
  _chan();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

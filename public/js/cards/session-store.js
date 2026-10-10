// Alpine.store('session') — Auth-/Session-State: wer ist eingeloggt und ist die
// Verbindung/Session noch gültig. Vorher flach in der Root-God-State; jetzt eine
// schmale, benannte Store-Oberfläche. Der Store-Name liefert den Namespace,
// darum tragen die Keys kein `session`-Präfix (Zugriff via `$store.session.currentUser`).
//
// Kein Root-Proxy-Spiegel (wie nav/tts/collab/jobs): Konsumenten greifen direkt
// zu — in den Root gespreadete Module + Root-Methoden via `this.$store.session.*`,
// Templates via `$store.session.*`, Karten/pure Helper via
// `Alpine.store('session').*`. Die zugehörigen Methoden (`logout`,
// `_handleSessionExpired`, Online/Offline-Handler) bleiben am Root.
//
// Feld-Bedeutung:
//   currentUser    — eingeloggter User (/auth/me) oder null vor Login. Liefert
//                  Rolle (`is_admin`), E-Mail, Name für Avatar/Admin-Gating.
//   sessionExpired — true nach einem 401 (globaler fetch-Wrapper → `session-expired`).
//                  Blendet den Session-Banner ein; kein Auto-Redirect, damit der
//                  User ungespeicherte Inhalte retten kann.
//   serverOffline  — true wenn der Server nicht erreichbar ist (Health-/Fetch-Fail).
//   isOffline      — true wenn der Browser offline ist (navigator.onLine === false).
//   pendingSyncCount — Anzahl Seiten mit lokal gesichertem, noch nicht
//                  synchronisiertem Entwurf (Reconnect-Outbox, app-outbox.js).
//                  Speist den Offline-Banner. Die aktuell offene Edit-Seite ist
//                  ausgenommen (sie ist „live", sonst flackert der Zähler).
//   offlineCapable — ein Service Worker kontrolliert die Seite; nur dann gibt
//                  es „Buch offline halten" (app/app-offline-books.js).
//   offlinePinned  — IDs (Strings) der Bücher, die dieses Konto offline hält.
//   offlineBooks   — Stand je Buch laut SW: { [id]: { at, total, failed } }.
//   offlineProgress — laufender Sync je Buch: { [id]: { done, total } }.
//   storagePersisted — Browser hat dauerhaften Speicher gewährt.
//   devMode        — Local-Dev-/Dev-Admin-Modus (LOCAL_DEV_MODE). Blendet z.B.
//                  den Logout-Eintrag der Command-Palette aus.

export function registerSessionStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('session', {
    currentUser: null,
    sessionExpired: false,
    serverOffline: false,
    isOffline: false,
    pendingSyncCount: 0,
    offlineCapable: false,
    offlinePinned: [],
    offlineBooks: {},
    offlineProgress: {},
    storagePersisted: false,
    devMode: false,
  });
}

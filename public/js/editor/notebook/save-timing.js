// Netz-Timing der Notebook-Saves (auch im Fokusmodus der SPA — derselbe
// Edit-Vorgang). Rein, ohne Imports: die Konstanten lesen auch Tests, die den
// Focus-Exit-Deckel dagegen prüfen.
//
// Write-Timeout eines Abschnitts-PUT. Bei wackligem Netz (Zug, Tunnel) meldet
// der Browser oft weiter „online", während die Leitung hängt; bis zum Abbruch
// startet kein weiterer Save, und ein vorgemerkter Fokus-Exit wartet mit.
// Abbrechen ist sicher: die Save-Kennung (repo/save-ids.js) und der
// Fingerabdruck (sent-saves.js) erkennen den Server-Stand als eigenen, falls
// der abgebrochene PUT doch angekommen ist. Ein Abschnitt ist klein genug, um
// auch über eine schwache Mobilfunk-Leitung in dieser Zeit hochzugehen.
export const PAGE_SAVE_TIMEOUT_MS = 30000;

// Zeitgesteuerter neuer Versuch nach einem gescheiterten Save (Netz/Server).
// `online` feuert bei einer hängenden Leitung nicht, und im Fokusmodus gibt es
// keinen Tab-Wechsel, der den Fokus-Retry auslöste — ohne Timer bliebe der
// Abschnitt bis zur nächsten Eingabe ungespeichert. Verdoppelt sich je
// Fehlversuch bis zum Deckel; ein gelungener Save setzt zurück.
export const SAVE_RETRY_BASE_MS = 10000;
export const SAVE_RETRY_MAX_MS = 120000;

// Fehlerklassen, bei denen der Timer greift: nur die, die sich von selbst
// erledigen. `auth` wartet auf das Neu-Anmelden (Session-Banner), `conflict`
// auf den nächsten Save bzw. die Auflösung — ein Timer brächte dort nur
// wiederholte 401 bzw. Merges ohne neuen Stand.
const TIMED_RETRY_KINDS = new Set(['network', 'server']);

export function wantsTimedRetry(kind) {
  return TIMED_RETRY_KINDS.has(kind);
}

// Wartezeit vor dem `attempt`-ten neuen Versuch (0-basiert).
export function saveRetryDelay(attempt) {
  const n = Math.max(0, Math.floor(attempt) || 0);
  return Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_BASE_MS * 2 ** Math.min(n, 20));
}

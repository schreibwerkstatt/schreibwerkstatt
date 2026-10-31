// Endet die Seite gerade (Reload, Navigation)? Dann bricht der Browser jeden
// laufenden Fetch ab und er scheitert mit `TypeError: Failed to fetch` — kein
// Fehler, sondern das Ende dieser Seite; die neue lädt selbst. Lade-Pfade, die
// ein Scheitern loggen, fragen hier, bevor sie es tun.

let unloading = false;

// Manche Unit-Tests stellen ein `window` ohne Event-API bereit.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { unloading = true; });
  // Firefox bricht den Fetch schon beim Navigationsstart ab, vor `pagehide`.
  // Wird die Navigation abgebrochen (Dirty-Guard), gibt der Timer das Log frei.
  window.addEventListener('beforeunload', () => {
    unloading = true;
    setTimeout(() => { unloading = false; }, 2000);
  });
  window.addEventListener('pageshow', () => { unloading = false; });
}

export function isPageUnloading() {
  return unloading;
}

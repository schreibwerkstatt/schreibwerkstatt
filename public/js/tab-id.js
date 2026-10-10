// Kennung dieses Tabs (dieser Seiteninstanz). Die Device-ID (device-id.js) ist
// pro Browser-Profil und damit in allen Tabs gleich — für alles, was zwei Tabs
// desselben Browsers auseinanderhalten muss (Live-Edit-Marker, Konflikt-Log),
// braucht es diese zweite Achse. Bewusst nur im Speicher: ein Neuladen ist eine
// neue Instanz, und sessionStorage würde beim Duplizieren des Tabs mitkopiert.

const TAB_ID = (() => {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const b = crypto.getRandomValues(new Uint8Array(6));
      return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* Fallback unten */ }
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
})();

export function getTabId() { return TAB_ID; }

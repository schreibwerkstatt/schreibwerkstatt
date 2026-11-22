'use strict';
// Verweildauer-Beacon für die Share-Leseansicht. Eigenständiges Modul (kein
// Alpine), liest #share-config selbst — analog tts.js. Misst die aktiv
// verbrachte Lesezeit und meldet sie an POST /share/:token/view-duration.
//
// Nur aktive Zeit zählt: der Tab ist sichtbar UND der Leser hat innerhalb der
// letzten IDLE_MS etwas getan (scrollen, tippen, klicken, tippen auf Touch,
// Text markieren) — oder er hört gerade zu (Vorlesen, Attribut
// `data-share-tts-reading` von tts.js; das zählt auch bei gesperrtem Bildschirm
// bzw. im Hintergrund-Tab). Danach steht die Uhr, bis wieder etwas passiert. Ohne diese Grenze zählte ein offen vergessener Tab bis zum
// Server-Deckel (6 h) als Lesezeit und verzerrte die Ø-Lesedauer des Autors.
//
// Gesendet wird bei jedem Wechsel in den Hintergrund und bei pagehide; der
// Server nimmt jeweils den grössten gemeldeten Wert (siehe db/share-links.js),
// darum darf mehrfach gesendet werden.

// Eine Bildschirmseite Prosa liest man deutlich schneller; wer zwei Minuten
// nichts tut, liest in aller Regel nicht mehr.
export const IDLE_MS = 2 * 60 * 1000;

/** Aktiver Anteil des Intervalls [from, now): voll, solange zugehört wird,
 *  sonst nur bis `lastInput + idleMs`. Pure, Node-testbar. */
export function activeMs(from, now, lastInput, { listening = false, idleMs = IDLE_MS } = {}) {
  if (now <= from) return 0;
  if (listening) return now - from;
  return Math.max(0, Math.min(now, lastInput + idleMs) - from);
}

if (typeof document !== 'undefined') (function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  const VIEW_ID = CFG.viewId;
  if (!TOKEN || !VIEW_ID) return;

  const visible = () => document.visibilityState === 'visible';
  const listening = () => document.documentElement.hasAttribute('data-share-tts-reading');

  let accumulatedMs = 0;
  let lastTick = Date.now();
  let lastInput = lastTick;   // das Öffnen der Seite zählt als Aktivität

  // Seit dem letzten Abrechnen aktive Zeit gutschreiben. Versteckt zählt nur
  // Zuhören.
  function settle() {
    const now = Date.now();
    const l = listening();
    if (visible() || l) accumulatedMs += activeMs(lastTick, now, lastInput, { listening: l });
    lastTick = now;
  }

  function onInput() {
    settle();
    lastInput = Date.now();
  }
  for (const ev of ['scroll', 'wheel', 'keydown', 'pointerdown', 'pointermove', 'touchstart']) {
    window.addEventListener(ev, onInput, { passive: true });
  }
  document.addEventListener('selectionchange', onInput);

  // Zuhören läuft ohne Eingabe weiter → regelmässig abrechnen, damit die
  // Vorlese-Zeit nicht erst beim nächsten Ereignis (dann ggf. ohne Zuhören)
  // bewertet wird.
  setInterval(settle, 15000);

  function send() {
    const durationMs = Math.round(accumulatedMs);
    if (durationMs <= 0) return;
    const payload = JSON.stringify({ viewId: VIEW_ID, durationMs });
    const url = `/share/${encodeURIComponent(TOKEN)}/view-duration`;
    // sendBeacon überlebt das Schliessen des Tabs; JSON via Blob, damit der
    // Server-JSON-Parser greift. Fallback: keepalive-fetch.
    let ok = false;
    try {
      if (navigator.sendBeacon) {
        ok = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      }
    } catch { ok = false; }
    if (!ok) {
      try {
        fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      } catch { /* best effort */ }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!visible()) {
      // Bis zum Verstecken abrechnen (settle prüft visible() — darum hier direkt).
      const now = Date.now();
      accumulatedMs += activeMs(lastTick, now, lastInput, { listening: listening() });
      lastTick = now;
      send();
    } else {
      // Versteckte Zeit zählt nur, wenn zugehört wurde (settle); die Rückkehr in
      // den Tab selbst ist Aktivität.
      if (listening()) settle(); else lastTick = Date.now();
      lastInput = Date.now();
    }
  });

  // pagehide (bfcache/Mobile) feuert nicht immer ein visibilitychange davor.
  window.addEventListener('pagehide', () => {
    settle();
    send();
  });
})();

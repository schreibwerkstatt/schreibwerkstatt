import { EVT } from '../../events.js';

// Bruecke zwischen der 'content-updated'-Meldung des Service Workers und dem
// App-Event-Bus.
//
// DER SW MELDET EINEN PFAD, NICHT EINE BEDEUTUNG. Er kennt weder Karten noch
// Sidebar; er weiss nur, dass die Hintergrund-Revalidierung dieses Pfads etwas
// anderes ergeben hat als der Cache-Stand, den er ausgeliefert hat
// (public/sw.js#notifyContentUpdated). Die Uebersetzung „Pfad → was heisst das
// fuer diese App" liegt hier, an EINER Stelle: sonst steht die Zerlegung von
// `/content/books/12/tree` in jedem Konsumenten noch einmal.
//
// Unbekannte Pfade fallen still weg. Die Gegenliste steht im SW
// (CONTENT_NOTIFY_REGEX) und entscheidet, WAS ueberhaupt verglichen wird; hier
// steht, was es bedeutet. Wer dort einen Pfad aufnimmt, braucht hier einen Zweig.

// '/content/books'         → { kind: 'books' }
// '/content/books/12/tree' → { kind: 'tree', bookId: '12' }
// '/content/pages/7'       → { kind: 'page', pageId: '7' }
export function parseContentPath(pathname) {
  const p = String(pathname || '');
  if (p === '/content/books') return { kind: 'books' };
  const m = /^\/content\/books\/(\d+)\/tree$/.exec(p);
  if (m) return { kind: 'tree', bookId: m[1] };
  const pm = /^\/content\/pages\/(\d+)$/.exec(p);
  if (pm) return { kind: 'page', pageId: pm[1] };
  return null;
}

export function installContentUpdatedBridge(signal) {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw) return;
  sw.addEventListener('message', (e) => {
    if (e.data?.type !== 'content-updated') return;
    const hit = parseContentPath(e.data.path);
    if (!hit) return;
    window.dispatchEvent(new CustomEvent(EVT.CONTENT_UPDATED, { detail: hit }));
  }, { signal });
}

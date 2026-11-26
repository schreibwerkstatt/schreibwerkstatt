// Tab-Kennung an eigenen Schreib-Requests (Header X-Tab-Id). Der Server
// (lib/live-writes.js) legt sie in den Request-Kontext; der Buch-Kanal des
// Event-Streams schickt die Live-Meldung des Requests dann an alle offenen
// Tabs und Geräte AUSSER dem auslösenden Tab (der hat seinen Stand schon).
// Nur eigene Origin, nur String-/URL-Ziele (ein Request-Objekt behielte seine
// Header nicht, wenn `init.headers` gesetzt wird) und nur Schreib-Methoden.

import { getTabId } from '../../tab-id.js';

export const TAB_HEADER = 'X-Tab-Id';

export function withTabHeader(input, init) {
  const method = String(init?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return init;
  if (typeof input !== 'string' && !(input instanceof URL)) return init;
  try {
    if (new URL(String(input), location.href).origin !== location.origin) return init;
  } catch { return init; }
  const headers = new Headers(init?.headers || undefined);
  headers.set(TAB_HEADER, getTabId());
  return { ...(init || {}), headers };
}

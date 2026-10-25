// UUID v4 für Client-IDs. `crypto.randomUUID` gibt es nur im sicheren Kontext
// (HTTPS, localhost) — über `http://host.lan` fehlt es. `getRandomValues` ist
// dagegen überall da, darum baut der Fallback die v4 daraus.
export function uuid() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c?.getRandomValues
    ? c.getRandomValues(new Uint8Array(16))
    : Uint8Array.from({ length: 16 }, () => Math.random() * 256 | 0);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

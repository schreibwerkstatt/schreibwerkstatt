// HTML-Escape-Atome. Basis für die XSS-Escape-Invariante (siehe CLAUDE.md
// „x-html nur mit vorab-escaptem Content").

// null/undefined → '' ; jeder andere Wert (auch 0) wird als String escaped.
// Pure, ohne Browser-Annahmen: auch serverseitig geladen (manuscript-render.js,
// figure-html.js via lib/esm-bridge.js bzw. lib/share-helpers.js).
export function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escHtml + Markdown-Fett-Marker entfernen. Lokale Modelle (v.a. ministral)
// streuen `**...**` inflationär in JSON-Felder; Rendern als <strong> wirkt
// überladen + Pairing bricht regelmässig. Darum nur strippen.
export function escMd(s) {
  return escHtml(String(s ?? '').replace(/\*\*/g, ''));
}

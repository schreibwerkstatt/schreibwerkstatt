// Buchtext-Tags im Prompt — ESM-Zwilling von routes/jobs/shared/book-text-format.js
// für die Prompt-Bausteine (Chats). Dort stehen Form und Begründung: Abschnitte als
// `<abschnitt titel="…">`, Kapitel als `<kapitel pfad="…">`, Such-Treffer ohne
// Abschnitt als `<treffer …>`; Namen wortgleich im Attribut (kein `&amp;`, Titel mit
// `"` in einfachen Anführungszeichen), eigene Tag-Namen im Text entschärft.
// Der Server-Modul ist CommonJS und wird synchron im Loader gebraucht, die Prompts
// sind ESM — darum zwei Fassungen, gleiche Ausgabe für gleiche Eingabe, gegated durch
// tests/unit/book-text-format-drift.test.mjs.

const TAG_KAPITEL = 'kapitel';
const TAG_ABSCHNITT = 'abschnitt';
const TAG_TREFFER = 'treffer';

export function xmlAttr(name, value) {
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!v.includes('"')) return `${name}="${v}"`;
  if (!v.includes("'")) return `${name}='${v}'`;
  return `${name}="${v.replace(/"/g, '&quot;')}"`;
}

function _extraAttrs(extra) {
  if (!extra) return '';
  return Object.entries(extra)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ' ' + xmlAttr(k, v))
    .join('');
}

const _OWN_TAG_RE = new RegExp(`<(/?)(${TAG_KAPITEL}|${TAG_ABSCHNITT}|${TAG_TREFFER})(?=[\\s>/])`, 'gi');
export function neutralizeOwnTags(text) {
  return String(text ?? '').replace(_OWN_TAG_RE, '‹$1$2');
}

/** Ein Abschnitt (`{ title, text }`), `extra` = weitere Attribute nach `titel`. */
export function formatAbschnitt(p, extra = null) {
  return `<${TAG_ABSCHNITT} ${xmlAttr('titel', p.title)}${_extraAttrs(extra)}>\n${neutralizeOwnTags(p.text)}\n</${TAG_ABSCHNITT}>`;
}

/** Ein Such-Treffer, der kein Abschnitt ist (Szene, Figur, Ort, Fakt). */
export function formatTreffer(attrs, text) {
  return `<${TAG_TREFFER}${_extraAttrs(attrs)}>\n${neutralizeOwnTags(text)}\n</${TAG_TREFFER}>`;
}

export function formatAbschnitte(pages) {
  return (pages || []).map(p => formatAbschnitt(p)).join('\n\n');
}

export function wrapKapitel(pfad, inner, extra = null) {
  return `<${TAG_KAPITEL} ${xmlAttr('pfad', pfad)}${_extraAttrs(extra)}>\n${inner}\n</${TAG_KAPITEL}>`;
}

export function formatKapitel(pfad, pages) {
  return wrapKapitel(pfad, formatAbschnitte(pages));
}

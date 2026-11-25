'use strict';
// Buchtext im KI-Prompt — das eine Format für jeden Job, der Abschnitte aus dem
// Loader (./loader.js#loadPageContents) an ein Modell schickt.
//
// Form:
//   <kapitel pfad="Teil 1 › Der Vater">
//   <abschnitt titel="Was macht Adrian?">
//   Erster Absatz …
//
//   »Komm her«, sagte sie.
//   </abschnitt>
//   </kapitel>
//
// Warum XML-Tags statt `## Kapitel` / `### Abschnitt` / `---`: der Abschnittstext
// trägt seine Absätze (`pageTextForAi`), und in echten Manuskripten stehen Zeilen
// wie `***`, `---` oder `# …` als Szenentrenner. Ein Markdown-Trenner wäre von
// ihnen nicht zu unterscheiden; ein Tag-Paar schon. Absätze tragen Dialogwechsel,
// Szenenschnitte und Rhythmus — ohne sie sah das Modell jeden Abschnitt als eine
// einzige Zeile.
//
// Namen bleiben wortgleich: die KI gibt `pfad`/`titel` als Bezug zurück
// (Szene.seite, Beleg-Kapitel, locateStelle), die Rückauflösung läuft über Namen
// (loader.js#idMapsFromContents). Darum kein Entity-Escaping von `&` im Attribut,
// und ein Titel mit `"` steht in einfachen Anführungszeichen. Erst ein Titel mit
// beiden Anführungszeichen braucht `&quot;`.
//
// Gegated: tests/unit/book-text-format.test.js.

// ./ai wird erst in pageTextForAi geladen: die Format-Funktionen sind pur und
// werden von reinen Helfern (komplett/utils.js) importiert, die Tests vor dem
// Mock von lib/ai laden — ein Top-Level-require zöge dort das echte lib/ai nach.

// Browser-/Prompt-Zwilling: public/js/prompts/book-text-format.js (die Chat-Prompts
// sind ESM). Gleiche Ausgabe für gleiche Eingabe, gegated durch
// tests/unit/book-text-format-drift.test.mjs.
const TAG_KAPITEL = 'kapitel';
const TAG_ABSCHNITT = 'abschnitt';
const TAG_TREFFER = 'treffer';

/** Attribut `name="value"`, Wert wortgleich (siehe Modulkopf). */
function xmlAttr(name, value) {
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!v.includes('"')) return `${name}="${v}"`;
  if (!v.includes("'")) return `${name}='${v}'`;
  return `${name}="${v.replace(/"/g, '&quot;')}"`;
}

// Zusätzliche Attribute in Einfüge-Reihenfolge; leere Werte (null, undefined, '')
// fallen weg, damit ein fehlender Kapitelpfad kein `kapitel=""` erzeugt.
function _extraAttrs(extra) {
  if (!extra) return '';
  return Object.entries(extra)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ' ' + xmlAttr(k, v))
    .join('');
}

// Ein Text, der selbst `<abschnitt` oder `</kapitel>` enthält (Fachbuch über XML,
// zitierter Prompt), würde die Struktur schliessen. Nur die eigenen Tag-Namen
// werden entschärft — jedes andere `<` bleibt, wie es geschrieben wurde.
const _OWN_TAG_RE = new RegExp(`<(/?)(${TAG_KAPITEL}|${TAG_ABSCHNITT}|${TAG_TREFFER})(?=[\\s>/])`, 'gi');
function neutralizeOwnTags(text) {
  return String(text ?? '').replace(_OWN_TAG_RE, '‹$1$2');
}

/** Ein Abschnitt (`{ title, text }`). `extra`: weitere Attribute nach `titel`
 *  (z.B. `{ kapitel, auszug }`). */
function formatAbschnitt(p, extra = null) {
  return `<${TAG_ABSCHNITT} ${xmlAttr('titel', p.title)}${_extraAttrs(extra)}>\n${neutralizeOwnTags(p.text)}\n</${TAG_ABSCHNITT}>`;
}

/** Ein Such-Treffer, der kein Abschnitt ist (Szene, Figur, Ort, Fakt). */
function formatTreffer(attrs, text) {
  return `<${TAG_TREFFER}${_extraAttrs(attrs)}>\n${neutralizeOwnTags(text)}\n</${TAG_TREFFER}>`;
}

/** Abschnitte eines Kapitels ohne Kapitel-Hülle — für Prompts, die das Kapitel
 *  selbst benennen (Multi-Pass-Chunk, Kapitel-Review). */
function formatAbschnitte(pages) {
  return (pages || []).map(p => formatAbschnitt(p)).join('\n\n');
}

/** Kapitel-Hülle um bereits formatierten Inhalt. */
function wrapKapitel(pfad, inner, extra = null) {
  return `<${TAG_KAPITEL} ${xmlAttr('pfad', pfad)}${_extraAttrs(extra)}>\n${inner}\n</${TAG_KAPITEL}>`;
}

/** Ein Kapitel mit seinen Abschnitten. */
function formatKapitel(pfad, pages) {
  return wrapKapitel(pfad, formatAbschnitte(pages));
}

/** Das ganze Buch (Gruppen aus loader.js#groupByChapter) in Lesereihenfolge. */
function formatBook(groups, groupOrder) {
  return (groupOrder || [])
    .map(key => {
      const g = groups.get(key);
      return formatKapitel(g.name, g.pages);
    })
    .join('\n\n');
}

/**
 * Seiten-HTML → Prompt-Text mit Absätzen. Der eine Weg für den Loader und jeden
 * Vergleich gegen dessen Text (Komplett-Delta).
 *
 * ASCII-Leerraum im HTML-Quelltext wird vorher zusammengefasst: er wird nicht
 * gerendert, und ein Zeilenumbruch im Markup soll keinen Umbruch im Prompt
 * erzeugen. Umbrüche entstehen nur an Block-Tags (`\n\n`) und `<br>` (`\n`) —
 * Regeln von ./ai.js#htmlToTextForPrompt. Ein geschütztes Leerzeichen (U+00A0) bleibt
 * stehen — `\s` träfe es mit, und «Geil.\u00A0 Ich» (gerendertes Doppel-Leerzeichen,
 * ein übernehmbarer Befund) fiele zu einem Space zusammen.
 */
function pageTextForAi(html, opts = {}) {
  const { htmlToTextForPrompt } = require('./ai');
  return htmlToTextForPrompt(String(html || '').replace(/[ \t\r\n\f]+/g, ' '), opts);
}

module.exports = {
  TAG_KAPITEL, TAG_ABSCHNITT, TAG_TREFFER,
  xmlAttr, neutralizeOwnTags,
  formatAbschnitt, formatTreffer, formatAbschnitte, wrapKapitel, formatKapitel, formatBook,
  pageTextForAi,
};

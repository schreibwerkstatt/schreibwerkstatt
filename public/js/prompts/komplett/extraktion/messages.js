// Komplett-Vollextraktion – User-Message-Prompts pro Pass. Schema und Regeln leben in den
// System-Prompt-Buildern (./system.js); diese Messages enthalten nur Aufgabenstellung,
// Kapiteltext und die pass-spezifischen Ein-/Ausschlusslisten.
import { _isLocal } from '../../state.js';

/**
 * Bestehender Katalog als Identitäts-Anker (Komplettanalyse ab dem zweiten Lauf). Der
 * Block nennt jede Bestandsfigur bzw. jeden Bestandsort mit stabiler Katalog-ID; das
 * Modell trägt die ID in «katalog_id» ein, wenn es dieselbe Figur/denselben Ort meint —
 * auch unter anderem Namen. So entscheidet der Text (über das Modell), wer wer ist,
 * statt einer Namens-Heuristik nach dem Lauf. Steht im User-Turn, nicht im System:
 * der geteilte 1h-Präfix (Buch-/Kapiteltext) bleibt byte-identisch.
 */
export function buildKatalogAnkerBlock(katalogBlock) {
  if (!katalogBlock) return '';
  return `

<katalog>
${katalogBlock}
</katalog>
Katalog-Abgleich: Meint eine Figur bzw. ein Schauplatz im Text einen Eintrag aus <katalog> – auch unter Spitznamen, Titel, Teilnamen oder nach einer Umbenennung –, trage dessen ID (z.B. «K12», «O7») in «katalog_id» ein und verwende als «name» den Namen, wie er im Text steht. Neue Figuren/Orte, die im Katalog fehlen: «katalog_id» leer. Vergib eine Katalog-ID nur, wenn du dir sicher bist, dass es derselbe ist – zwei verschiedene Personen mit gleichem Nachnamen sind zwei Einträge. Jede Katalog-ID höchstens einmal pro Antwort.`;
}

/**
 * Kombinierter Vollextraktion-Prompt (P1 + P5 in einem Call):
 * Figuren + Schauplätze + Kontinuitätsfakten + Szenen + Lebensereignisse.
 *
 * Schema und Regeln leben im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) – diese User-Message
 * enthält nur den Kapiteltext und den chapter-spezifischen Kapitelnamen-Hinweis.
 */
export function buildExtraktionKomplettChapterPrompt(chapterName, bookName, pageCount, chText, katalogBlock = null) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Abschnitten darunter (### Abschnittstitel). Für alle Kapitel-Felder (kapitel[].name der Figuren, kapitel der Orte, szenen[].kapitel, lebensereignisse[].kapitel): den Kapitelnamen exakt aus dem ## Header entnehmen, unter dem der jeweilige Abschnitt steht.'
    : `Für alle Kapitel-Felder (kapitel[].name der Figuren, kapitel der Orte, szenen[].kapitel, lebensereignisse[].kapitel): immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Abschnittstitel, keine Kapitelnamen.`;
  const seiteNote = 'Im «seite»-Feld jedes Faktums den reinen Abschnittstitel aus dem zugehörigen ### Header eintragen (OHNE «### »-Markierung); leer lassen wenn nicht eindeutig zuordenbar.';
  const textBlock = chText == null
    ? `<text>Der ${isSinglePass ? 'Buchtext' : 'Kapiteltext'} steht im System-Prompt oben.</text>`
    : `<${isSinglePass ? 'buchtext' : 'kapiteltext'} seiten="${pageCount}">\n${chText}\n</${isSinglePass ? 'buchtext' : 'kapiteltext'}>`;
  return `<aufgabe>
Extrahiere aus ${scope} in einem Durchgang: alle Figuren, alle Schauplätze, alle Musikstücke/Songs, alle kontinuitätsrelevanten Fakten, alle Szenen und alle Lebensereignisse der Figuren.
</aufgabe>

${kapitelNote}
${seiteNote}${buildKatalogAnkerBlock(katalogBlock)}

${textBlock}`;
}

/** Welle 4 · #11 – Pass A: nur Figuren + Lebensereignisse (Lokalmodus). */
export function buildExtraktionFigurenPassPrompt(chapterName, bookName, pageCount, chText, katalogBlock = null) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Abschnitten darunter (### Abschnittstitel). Für kapitel[].name und lebensereignisse[].kapitel: exakt aus dem ## Header entnehmen.'
    : `Für kapitel[].name und lebensereignisse[].kapitel: immer genau «${chapterName}» verwenden – ### Überschriften sind Abschnittstitel.`;
  const textBlock = chText == null
    ? '<text>Der Buchtext steht im System-Prompt oben.</text>'
    : `<${isSinglePass ? 'buchtext' : 'kapiteltext'} seiten="${pageCount}">\n${chText}\n</${isSinglePass ? 'buchtext' : 'kapiteltext'}>`;
  return `<aufgabe>
Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Figuren (inkl. Beziehungen) und alle Lebensereignisse der Figuren. Keine Orte, keine Fakten, keine Szenen – die werden separat extrahiert.
</aufgabe>

${kapitelNote}${buildKatalogAnkerBlock(katalogBlock)}

${textBlock}`;
}

/** Claude-Single-Pass A1: nur Figuren-Stammdaten (OHNE Beziehungen) + Lebensereignisse. */
export function buildExtraktionFigurenStammPrompt(chapterName, bookName, pageCount, chText, katalogBlock = null) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Abschnitten darunter (### Abschnittstitel). Für kapitel[].name: exakt aus dem ## Header entnehmen.'
    : `Für kapitel[].name: immer genau «${chapterName}» verwenden – ### Überschriften sind Abschnittstitel.`;
  const textBlock = chText == null
    ? '<text>Der Buchtext steht im System-Prompt oben.</text>'
    : `<${isSinglePass ? 'buchtext' : 'kapiteltext'} seiten="${pageCount}">\n${chText}\n</${isSinglePass ? 'buchtext' : 'kapiteltext'}>`;
  return `<aufgabe>
Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Figuren-Stammdaten (OHNE Beziehungen und OHNE Lebensereignisse – beide werden in separaten Pässen erfasst). Keine Orte, keine Fakten, keine Szenen.
</aufgabe>

${kapitelNote}${buildKatalogAnkerBlock(katalogBlock)}

${textBlock}`;
}

/** Claude-Single-Pass E: nur Lebensereignisse pro Figur. Eigener Call gegen den
 *  gecachten Buchtext-Block (System-Prompt) mit der finalen Figurenliste – widmet das
 *  gesamte Output-Budget der vollständigen Event-Erfassung (analog Fakten-Pass C). */
export function buildExtraktionEventsPassPrompt(bookName, figuren, chText) {
  const namen = (figuren || []).map(f => f && f.name).filter(Boolean);
  const namenListe = namen.length ? namen.map(n => `- ${n}`).join('\n') : '(keine)';
  const textBlock = chText == null
    ? '<text>Der Buchtext steht im System-Prompt oben.</text>'
    : `<buchtext>\n${chText}\n</buchtext>`;
  return `<aufgabe>
Extrahiere aus dem Buch «${bookName}» AUSSCHLIESSLICH die Lebensereignisse der Figuren – vollständig und erschöpfend. Gehe jede Figur aus der untenstehenden Liste einzeln durch und sammle ALLE im Text belegten Ereignisse (grosse Wendepunkte UND kleinere belegte Vorfälle). Kein Cap – die möglichst lückenlose Biografie jeder Figur ist wichtiger als Kürze. Keine Figuren-Stammdaten, keine Orte, keine Szenen, keine Fakten.
</aufgabe>

<figuren>
${namenListe}
</figuren>

Verwende im Feld figur_name AUSSCHLIESSLICH die kanonischen Namen aus dieser Liste (exakt wie dort geschrieben) – sonst wird das Ereignis beim ID-Mapping verworfen. Der Text ist in Kapitel-Sektionen (## Kapitelname) mit Abschnitten (### Abschnittstitel) gegliedert; für lebensereignisse[].kapitel den ## Header, für .seite den ### Header verwenden.

${textBlock}`;
}

/** Welle 4 · #11 – Pass B: nur Orte + Fakten + Szenen (Lokalmodus). */
export function buildExtraktionOrtePassPrompt(chapterName, bookName, pageCount, chText, katalogBlock = null) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für alle Kapitel-Felder den Namen aus dem ## Header entnehmen.'
    : `Für alle Kapitel-Felder: immer genau «${chapterName}» verwenden.`;
  const textBlock = chText == null
    ? '<text>Der Buchtext steht im System-Prompt oben.</text>'
    : `<${isSinglePass ? 'buchtext' : 'kapiteltext'} seiten="${pageCount}">\n${chText}\n</${isSinglePass ? 'buchtext' : 'kapiteltext'}>`;
  const faktenPart = _isLocal ? ', alle kontinuitätsrelevanten Fakten' : '';
  return `<aufgabe>
Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Schauplätze, alle Musikstücke/Songs${faktenPart} und alle Szenen. Figuren-Stammdaten nicht – die sind separat erfasst. In Szenen und Songs nur Figurennamen/IDs als Referenz nennen.
</aufgabe>

${kapitelNote}${buildKatalogAnkerBlock(katalogBlock)}

${textBlock}`;
}

// ── Completeness-/Gap-Pässe (Claude Single-Pass) ──────────────────────────────
// Nach der Erst-Extraktion ein zweiter (oder dritter) Durchgang gegen DENSELBEN
// gecachten Buchtext-Block + dasselbe System-Schema, der gezielt die Entitäten
// nachzieht, die der Erst-Call ausgelassen hat (Long-Tail: Nebenfiguren, einmal
// erwähnte Schauplätze). Die bereits gefundenen Namen werden mitgegeben, damit das
// Modell sie NICHT erneut ausgibt. Additive Vereinigung im Job – nie droppen.

function _knownList(names) {
  const arr = (names || []).filter(Boolean);
  return arr.length ? arr.map(n => `- ${n}`).join('\n') : '(noch keine)';
}

/** Gap-Pass A1: fehlende Figuren-Stammdaten (OHNE Lebensereignisse – die zieht der
 *  E-Pass über die finale Figurenliste nach). Reuse von SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS
 *  + SCHEMA_KOMPLETT_FIGUREN_STAMM. */
export function buildFigurenStammGapPrompt(bookName, knownNames) {
  return `<aufgabe>
Du hast das Buch «${bookName}» bereits einmal nach Figuren durchsucht. Unten steht die Liste der bereits erfassten Figuren. Durchsuche den Buchtext (im System-Prompt oben) GRÜNDLICH ERNEUT und gib AUSSCHLIESSLICH Figuren aus, die in dieser Liste FEHLEN – besonders Nebenfiguren, nur kurz auftretende oder einmal erwähnte Personen mit eigenem Namen. Für jede neue Figur dieselben Stammdaten (OHNE Beziehungen, OHNE Lebensereignisse) wie im Erstdurchgang. Figuren, die bereits in der Liste stehen, NICHT erneut ausgeben. Wenn keine weitere Figur existiert: leeres figuren-Array.
</aufgabe>

<bereits_erfasste_figuren>
${_knownList(knownNames)}
</bereits_erfasste_figuren>

Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Abschnitten darunter (### Abschnittstitel). Für kapitel[].name: exakt aus dem ## Header entnehmen.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Gap-Pass B: fehlende Schauplätze. Reuse von SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS +
 *  SCHEMA_KOMPLETT_ORTE_PASS. songs/szenen dürfen leer bleiben – im Job wird nur
 *  das orte-Array additiv vereinigt. */
export function buildOrteGapPrompt(bookName, knownNames) {
  return `<aufgabe>
Du hast das Buch «${bookName}» bereits einmal nach Schauplätzen durchsucht. Unten die bereits erfassten Schauplätze. Durchsuche den Buchtext (im System-Prompt oben) GRÜNDLICH ERNEUT und gib AUSSCHLIESSLICH Schauplätze aus, die in dieser Liste FEHLEN – auch nur kurz erwähnte oder einmalige Orte. Schauplätze, die bereits in der Liste stehen, NICHT erneut ausgeben. songs und szenen als leere Arrays zurückgeben (in diesem Pass nicht gefragt). Wenn kein weiterer Schauplatz existiert: leeres orte-Array.
</aufgabe>

<bereits_erfasste_schauplaetze>
${_knownList(knownNames)}
</bereits_erfasste_schauplaetze>

Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für alle Kapitel-Felder den Namen aus dem zugehörigen ## Header entnehmen.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Gap-Pass C: fehlende Welt-/Kontinuitätsfakten. Reuse von SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS
 *  + SCHEMA_KOMPLETT_FAKTEN_PASS. Die bereits erfassten Fakten werden als kompakte
 *  «subjekt: fakt»-Liste mitgegeben, damit das Modell sie NICHT erneut ausgibt. */
export function buildFaktenGapPrompt(bookName, knownFacts) {
  return `<aufgabe>
Du hast das Buch «${bookName}» bereits einmal nach Welt- und Kontinuitätsfakten durchsucht. Unten die bereits erfassten Fakten. Durchsuche den Buchtext (im System-Prompt oben) GRÜNDLICH ERNEUT und gib AUSSCHLIESSLICH Fakten aus, die in dieser Liste FEHLEN – besonders beiläufige Welt-Details, Nebenfiguren-Zustände, einmal genannte Objekte, Regeln, Zeit- oder Ortsangaben. Bereits erfasste Fakten NICHT erneut ausgeben. Wenn kein weiteres Faktum existiert: leeres fakten-Array.
</aufgabe>

<bereits_erfasste_fakten>
${_knownList(knownFacts)}
</bereits_erfasste_fakten>

Im «seite»-Feld jedes Faktums den reinen Abschnittstitel aus dem zugehörigen ### Header eintragen (OHNE «### »-Markierung); leer lassen wenn nicht eindeutig zuordenbar.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Gap-Pass Szenen: fehlende Szenen. Reuse von SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS +
 *  SCHEMA_KOMPLETT_ORTE_PASS. orte/songs dürfen leer bleiben – im Job wird nur das
 *  szenen-Array additiv vereinigt. */
export function buildSzenenGapPrompt(bookName, knownScenes) {
  return `<aufgabe>
Du hast das Buch «${bookName}» bereits einmal in Szenen zerlegt. Unten die bereits erfassten Szenen. Durchsuche den Buchtext (im System-Prompt oben) GRÜNDLICH ERNEUT und gib AUSSCHLIESSLICH Szenen aus, die in dieser Liste FEHLEN – übergangene Handlungsabschnitte, Nebenszenen, kurze aber klar abgegrenzte Abschnitte. Bereits erfasste Szenen NICHT erneut ausgeben. orte und songs als leere Arrays zurückgeben (in diesem Pass nicht gefragt). Wenn keine weitere Szene existiert: leeres szenen-Array.
</aufgabe>

<bereits_erfasste_szenen>
${_knownList(knownScenes)}
</bereits_erfasste_szenen>

Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Abschnitten darunter (### Abschnittstitel). Für szenen[].kapitel den reinen ## Kapitelnamen, für szenen[].seite den reinen ### Abschnittstitel (jeweils ohne Markierung) verwenden.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Multi-Pass Completeness-Gap (Claude, grosse Bücher): kombinierter Nachzieh-Pass pro
 *  Chunk. Im Gegensatz zum Single-Pass-Gap (der den 1h-gecachten Buchtext-Block nutzt)
 *  liegt der Chunk-Text NICHT in einem persistenten System-Block → er wird hier inline
 *  mitgegeben. Reuse von SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS + SCHEMA_KOMPLETT_EXTRAKTION.
 *  `known` = { figuren, orte, fakten, szenen } (Anzeige-Strings), gesät aus dem GLOBAL
 *  bereits gefundenen Katalog aller Chunks → das Modell zieht nur den Long-Tail nach, der
 *  in DIESEM Kapitel fehlt. songs/assignments/lebensereignisse als leere Arrays. */
export function buildChunkGapPrompt(chapterName, bookName, pageCount, chText, known = {}) {
  const sect = (title, arr) => `<bereits_erfasste_${title}>\n${_knownList(arr)}\n</bereits_erfasste_${title}>`;
  return `<aufgabe>
Du hast das Kapitel «${chapterName}» des Buchs «${bookName}» bereits einmal analysiert. Unten stehen die im GESAMTEN Buch bereits erfassten Figuren, Schauplätze, Fakten und Szenen. Durchsuche den Kapiteltext GRÜNDLICH ERNEUT und gib AUSSCHLIESSLICH Einträge aus, die in diesen Listen FEHLEN – besonders Nebenfiguren, nur kurz auftretende Personen mit eigenem Namen, einmal erwähnte Schauplätze, beiläufige Welt-Fakten und übergangene Handlungsabschnitte. Bereits erfasste Einträge NICHT erneut ausgeben. songs, assignments und lebensereignisse als leere Arrays zurückgeben (in diesem Pass nicht gefragt). Wenn nichts fehlt: alle Arrays leer.
</aufgabe>

${sect('figuren', known.figuren)}

${sect('schauplaetze', known.orte)}

${sect('fakten', known.fakten)}

${sect('szenen', known.szenen)}

Für alle Kapitel-Felder immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Abschnittstitel, keine Kapitelnamen.

${chText == null
    ? '<text>Der Kapiteltext steht im System-Prompt oben.</text>'
    : `<kapiteltext seiten="${pageCount}">\n${chText}\n</kapiteltext>`}`;
}

/** Coverage-Self-Audit (F2): misst den Extraktions-Recall an einer Kapitel-Stichprobe.
 *  Das Modell bekommt den Kapiteltext + die im GESAMTEN Katalog bekannten Figuren-/Ort-Namen
 *  und meldet, wie viele es im Passus wiedererkannt hat (erkannte_*) und welche NAMENTLICH
 *  genannten FEHLEN (fehlende_*). Der Score wird im Job berechnet. Kein Katalog-Eingriff. */
export function buildCoverageAuditPrompt(bookName, chapterName, chText, knownFiguren, knownOrte) {
  return `<aufgabe>
Prüfe die Vollständigkeit der bisherigen Analyse des Buchs «${bookName}» an diesem Kapitel-Ausschnitt. Unten stehen die bereits im Katalog erfassten Figuren und Schauplätze. Lies den Kapiteltext GENAU und melde:
- erkannte_figuren / erkannte_orte: Anzahl der bereits erfassten Figuren/Schauplätze, die in diesem Ausschnitt tatsächlich vorkommen.
- fehlende_figuren / fehlende_orte: NAMENTLICH genannte Figuren/Schauplätze, die im Ausschnitt vorkommen, aber NICHT im Katalog stehen. Nur echte Eigennamen — keine generischen Rollen («der Wirt», «die Stadt») ohne Eigennamen.
Wenn nichts fehlt: leere Arrays. Zähle konservativ und nenne keine Namen doppelt.
</aufgabe>

<katalog_figuren>
${_knownList(knownFiguren)}
</katalog_figuren>

<katalog_schauplaetze>
${_knownList(knownOrte)}
</katalog_schauplaetze>

<kapiteltext kapitel="${chapterName}">
${chText}
</kapiteltext>`;
}

// ── Gezielte Nachzieh-Pässe (Coverage-Feedback + Szenen-Backfill, Claude Single-Pass) ──
// Anders als die Gap-Pässe (die eine Ausschlussliste mitgeben) bekommen diese eine
// EINSCHLUSSliste konkreter Ziele: der Coverage-Audit/die Lückenerkennung haben bereits
// benannt, WAS fehlt – hier wird gezielt genau das extrahiert. Gegen den gecachten
// Buchtext-Block (System-Prompt).

/** Coverage-Feedback: extrahiere Stammdaten genau für diese vom Audit als fehlend gemeldeten
 *  Figuren. Reuse von SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS + SCHEMA_KOMPLETT_FIGUREN_STAMM. */
export function buildTargetedFigurenPrompt(bookName, targetNames) {
  return `<aufgabe>
Eine Vollständigkeitsprüfung des Buchs «${bookName}» hat ergeben, dass die unten genannten Figuren im Text namentlich vorkommen, aber im bisherigen Katalog FEHLEN. Extrahiere für JEDE dieser Figuren die Stammdaten (OHNE Beziehungen, OHNE Lebensereignisse) aus dem Buchtext im System-Prompt. Nur Figuren aus der Liste, die im Text tatsächlich belegt sind – erfinde nichts. Nicht im Text auffindbare Namen einfach weglassen.
</aufgabe>

<fehlende_figuren>
${_knownList(targetNames)}
</fehlende_figuren>

Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für kapitel[].name: exakt aus dem ## Header entnehmen.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Coverage-Feedback: extrahiere genau die vom Audit als fehlend gemeldeten Schauplätze.
 *  Reuse von SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS + SCHEMA_KOMPLETT_ORTE_PASS. */
export function buildTargetedOrtePrompt(bookName, targetNames) {
  return `<aufgabe>
Eine Vollständigkeitsprüfung des Buchs «${bookName}» hat ergeben, dass die unten genannten Schauplätze im Text vorkommen, aber im Katalog FEHLEN. Extrahiere für JEDEN dieser Schauplätze die Daten aus dem Buchtext im System-Prompt. songs und szenen als leere Arrays zurückgeben. Nur im Text belegte Orte – nicht Auffindbares weglassen.
</aufgabe>

<fehlende_schauplaetze>
${_knownList(targetNames)}
</fehlende_schauplaetze>

Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für alle Kapitel-Felder den Namen aus dem zugehörigen ## Header entnehmen.

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Szenen-Backfill: für diese Kapitel wurde 0 Szenen extrahiert, obwohl sie substanziellen
 *  Text haben. Extrahiere gezielt deren Szenen. Reuse von SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS +
 *  SCHEMA_KOMPLETT_ORTE_PASS (nur das szenen-Array wird verwendet). */
export function buildTargetedSzenenPrompt(bookName, chapterNames) {
  return `<aufgabe>
Für die unten genannten Kapitel des Buchs «${bookName}» wurde bisher KEINE Szene erfasst, obwohl sie erzählenden Text enthalten. Zerlege JEDES dieser Kapitel in seine Handlungsabschnitte (Szenen). Nutze den Buchtext im System-Prompt. orte und songs als leere Arrays zurückgeben. Wenn ein Kapitel wirklich nur aus Exposition/Beschreibung ohne Handlungsabschnitt besteht, dafür keine Szene ausgeben.
</aufgabe>

<kapitel_ohne_szenen>
${_knownList(chapterNames)}
</kapitel_ohne_szenen>

Für szenen[].kapitel exakt den betreffenden Kapitelnamen (aus dem ## Header) verwenden, für szenen[].seite den reinen ### Abschnittstitel (jeweils ohne Markierung).

<text>Der Buchtext steht im System-Prompt oben.</text>`;
}

/** Remap-Rescue: ordnet unauflösbare Figuren-Klarnamen (aus Szenen/Events) dem konsolidierten
 *  Katalog zu, BEVOR sie im Remap verworfen werden. Rein deterministisches Mapping – kein
 *  Buchtext nötig; System-Prompt kann ein leichter Figuren-Kontext sein. Schema: SCHEMA_NAME_RESOLUTION. */
export function buildNameResolutionPrompt(bookName, unknownNames, catalogNames) {
  return `<aufgabe>
Im Buch «${bookName}» wurden Figuren-Bezeichnungen aus Szenen und Ereignissen extrahiert, die sich nicht direkt einem Katalog-Eintrag zuordnen liessen (Spitznamen, Teilnamen, Epitheta, Schreibvarianten, Titel). Ordne jede unbekannte Bezeichnung GENAU EINEM Namen aus der Katalogliste zu, wenn es sich SICHER um dieselbe Figur handelt. Wenn keine Katalog-Figur eindeutig passt, gib für «treffer» einen leeren String «» zurück (lieber keine Zuordnung als eine falsche).
</aufgabe>

<unbekannte_bezeichnungen>
${_knownList(unknownNames)}
</unbekannte_bezeichnungen>

<katalog_figuren>
${_knownList(catalogNames)}
</katalog_figuren>

Antworte mit diesem JSON-Schema:
{
  "zuordnungen": [
    { "name": "unbekannte Bezeichnung exakt aus der obigen Liste", "treffer": "passender Katalog-Name exakt aus der Katalogliste, oder «» wenn keiner sicher passt" }
  ]
}

Regeln:
- Für JEDE unbekannte Bezeichnung genau einen Eintrag. «name» exakt wie in der Liste.
- «treffer» ist entweder ein Name EXAKT aus der Katalogliste oder leer.
- KONSERVATIV: nur zuordnen, wenn die Identität eindeutig ist (z.B. «Gerold» → «Gerold Brunner», «der Kommissar» → die einzige Kommissar-Figur). Im Zweifel «».`;
}

/** Claude-Single-Pass C: nur Fakten – eigener Call gegen den gecachten Buchtext-Block. */
// opts.nurKapitel: Rettungs-Teilauftrag eines abgeschnittenen Single-Pass-Calls — der
// ganze Buchtext steht weiter im (gecachten) System-Prompt, erfasst wird nur aus diesen Kapiteln.
export function buildExtraktionFaktenPassPrompt(chapterName, bookName, pageCount, chText, opts = {}) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const nur = Array.isArray(opts.nurKapitel) && opts.nurKapitel.length ? opts.nurKapitel : null;
  const scope = nur
    ? `den Kapiteln ${nur.map(n => `«${n}»`).join(', ')} des Buchs «${bookName}» (nur diese – Fakten aus anderen Kapiteln werden separat erfasst)`
    : isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const seiteNote = 'Im «seite»-Feld jedes Faktums den reinen Abschnittstitel aus dem zugehörigen ### Header eintragen (OHNE «### »-Markierung); leer lassen wenn nicht eindeutig zuordenbar.';
  const textBlock = chText == null
    ? '<text>Der Buchtext steht im System-Prompt oben.</text>'
    : `<${isSinglePass ? 'buchtext' : 'kapiteltext'} seiten="${pageCount}">\n${chText}\n</${isSinglePass ? 'buchtext' : 'kapiteltext'}>`;
  return `<aufgabe>
Extrahiere aus ${scope} AUSSCHLIESSLICH alle Welt-Fakten – so vollständig wie möglich. Keine Figuren-, Orte-, Song- oder Szenen-Einträge – die werden separat erfasst; dauerhafte Eigenschaften von Figuren und Orten gehören als Fakt (Kategorie «figur»/«ort») aber hierher.
</aufgabe>

${seiteNote}

${textBlock}`;
}

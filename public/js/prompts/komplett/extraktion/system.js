// Komplett-Vollextraktion – Schemas + System-Prompt-Builder: kombiniertes Schema (Claude)
// + Split-Schemas (lokale Modelle) und die (gecachten) System-Prompt-Builder pro Pass.
// Die User-Message-Prompts pro Pass liegen in ./messages.js.
import { _isLocal, _jsonOnly } from '../../state.js';
import {
  FIGUREN_BASIS_SCHEMA,
  FIGUREN_STAMM_SCHEMA,
  figurenBasisRules,
  ORTE_SCHEMA,
  ORTE_RULES,
  SONGS_SCHEMA,
  SONGS_RULES,
  FAKTEN_SCHEMA,
  FAKTEN_RULES,
  _schemaBody,
  _ASSIGNMENTS_SCHEMA_BLOCK,
  _EREIGNIS_RULES,
} from '../schema-strings.js';

// Kombiniertes Schema für Komplett-Extraktion (P1+P5 merged).
// buildSystemKomplett() bettet es in den System-Prompt ein → Caching über alle Kapitel-Calls.
// figuren_namen / orte_namen / figur_name: Klarnamen statt IDs, da konsolidierte IDs
// erst nach P2/P3 bekannt sind. Remapping nach der Konsolidierung in jobs.js.
function buildKomplettSchemaStatic(kontext = '') {
  const schemaPart = `Priorität: Figuren und deren Beziehungen korrekt erfassen. Fakten und Szenen vollständig erfassen.

Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)},
  ${_schemaBody(SONGS_SCHEMA)},
  ${FAKTEN_SCHEMA},
  "szenen": [
    {
      "seite": "NUR der reine Abschnittstitel aus einem ### Header – OHNE die ###-Markierung und OHNE führende Leerzeichen. Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?». NIEMALS den Kapitelnamen als seite. Leer wenn kein passender ### Header identifizierbar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE die ##-Markierung. Beispiel: aus «## Der Vater» wird «Der Vater». Nicht der ### Abschnitts-Header. Leer wenn unklar.",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "Begründung der wertung + Verbesserungshinweis (2-3 Sätze): WARUM ist die Szene stark/mittel/schwach – konkret festgemacht an Spannung, Tempo, Figurenentwicklung, Konflikt/Ziel, Dialog oder Struktur. Bei «mittel»/«schwach» mindestens einen konkreten, umsetzbaren Verbesserungshinweis nennen; bei «stark» benennen, was sie trägt.",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ],
  "assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "Original-Datum-Notation (JJJJ, JJJJ-MM, JJJJ-MM-TT, «Mai 1850», «Tag 3», «vor der Reise», …)",
          "datum_label": "User-lesbarer Original-String – identisch oder lesbarer als datum.",
          "datum_year":  1850,        // Jahreszahl als INT (negativ für v.Chr.); null wenn unbekannt
          "datum_month": 5,           // 1–12; null wenn unbekannt
          "datum_day":   12,          // 1–31; null wenn unbekannt
          "datum_ende_year":  null,   // Spanne (Krieg, Reise, Schwangerschaft, Studium): Ende-Jahr
          "datum_ende_month": null,
          "datum_ende_day":   null,
          "story_tag":   null,        // Relative Story-Zeit (Tag 3, Day 12) wenn kein realer Kalender
          "datum_unsicher": false,    // true NUR wenn datum_year aus dem Kontext abgeleitet (nicht explizit belegt) wurde
          "subtyp":      "wendepunkt", // geburt|tod|hochzeit|liebe|trennung|krankheit|reise|umzug|konflikt|wendepunkt|entdeckung|verlust|sieg|extern_politisch|extern_wirtschaftlich|extern_natur|extern_kulturell|extern_krieg|sonstiges (Default 'sonstiges')
          "ereignis": "Was passierte – neutral und kanonisch formuliert, NICHT aus der Figurenperspektive. Ereignisse die mehrere Figuren betreffen MÜSSEN bei allen beteiligten Figuren identisch formuliert sein (z.B. 'Geburt von Maria' für Vater, Mutter und Kind – nicht 'Geburt seiner Tochter' oder 'Eigene Geburt').",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "NUR der reine Abschnittstitel aus einem ### Header – OHNE ###-Markierung. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Abschnitts-Header. Leer wenn unklar."
        }
      ]
    }
  ]
}`;

  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- IDs eindeutig (fig_1, ort_1, song_1, …); Beziehungen nur zwischen IDs aus dieser Liste.
- KONSERVATIV: Nur aufnehmen was im Text eindeutig belegt ist. Im Zweifel weglassen.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: immer der Kapitelname (aus dem ## Header oder dem Prompt-Kontext), niemals Abschnittstitel.
- figuren_namen / orte_namen / figur_name: Klarnamen exakt wie im Text.
- Songs: nur mit konkretem Titel oder Interpret aufnehmen; kontext_typ Pflicht.
- Ereignisse: datum_label = Original-String, datum_year/month/day strukturiert (jeweils null wenn unbekannt). Ist das Jahr nicht explizit, aber aus dem Kontext erschliessbar (verankerte Jahreszahl + relative Angaben, Lebensspanne, Epoche), das abgeleitete Jahr trotzdem in datum_year eintragen und datum_unsicher=true setzen; sonst datum_unsicher=false. subtyp aus Whitelist; im Zweifel 'sonstiges'. Gleiches Ereignis bei allen beteiligten Figuren identisch formulieren.
- Leere Arrays wenn nichts gefunden.`;
  }

  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

Schauplatz-Regeln:
${ORTE_RULES}

Musik-Regeln:
${SONGS_RULES}

${FAKTEN_RULES}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- seite: NUR der reine Abschnittstitel, OHNE die «### »-Markierung am Anfang. Aus «### Was macht Adrian?» wird «Was macht Adrian?». Wortwörtlich sonst (Gross-/Kleinschreibung, Satzzeichen). Leer lassen wenn kein passender ### Header identifizierbar. Der Kapitelname ist NIE ein gültiger Wert für seite.
- kapitel: NUR der reine Kapitelname aus dem ## Header, OHNE die «## »-Markierung.
- figuren_namen: aktiv beteiligte Figuren – Namen exakt wie im Text (vollständiger Name oder Spitzname); leeres Array wenn keine Figur beteiligt
- orte_namen: Schauplatz der Szene – exakter Name wie im Text; leeres Array wenn kein konkreter Ort erwähnt
- wertung: «stark» = überzeugend/spannend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- kommentar MUSS die wertung begründen (woran festgemacht) und bei «mittel»/«schwach» einen konkreten Verbesserungshinweis geben – keine reine Zusammenfassung des Inhalts
- Kein Cap auf Anzahl Szenen – vollständige Erfassung aller Handlungsabschnitte wichtiger als Kürze. Pro Kapitel mit Handlung mindestens eine Szene.
- Nur wenn ein Kapitel ausschliesslich aus Exposition/Beschreibung ohne Handlungsabschnitt besteht: «szenen» als leeres Array

Ereignis-Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen: Kriege, politische Umbrüche, Sport- und Kulturereignisse, Wirtschaftskrisen, Seuchen, Naturkatastrophen; auch wenn nur kurz erwähnt; jedes externe Ereignis ALLEN betroffenen Figuren zuweisen
- subtyp: feiner Subtyp (Whitelist) – geburt, tod, hochzeit, liebe, trennung, krankheit, reise, umzug, konflikt, wendepunkt, entdeckung, verlust, sieg (für typ=persoenlich) bzw. extern_politisch, extern_wirtschaftlich, extern_natur, extern_kulturell, extern_krieg (für typ=extern). liebe=Beginn einer Liebesbeziehung; trennung=Scheidung/Trennung; krankheit=Erkrankung/Verletzung; umzug=dauerhafter Wohnortwechsel (nicht reise); extern_wirtschaftlich=Wirtschaftskrise/Crash; extern_krieg=Krieg/Schlacht. Wenn nichts klar passt: 'sonstiges'.
- datum: Original-String wie im Text vorhanden (z.B. «Mai 1850», «12. März 1850», «1850», «Tag 3», «vor der Reise»). datum_label spiegelt das in einer user-lesbaren Form.
- datum_year/datum_month/datum_day PFLICHT zerlegen falls aus Text/Kontext berechenbar; Felder ohne Information null lassen.
- JAHRES-INFERENZ (wichtig): Steht am Ereignis kein explizites Datum, ist das Jahr aber aus dem Kontext erschliessbar – aus einer vorher verankerten Jahreszahl plus relativen Angaben («zwei Jahre später», «im Frühjahr darauf», «als sie 30 war»), aus der Lebensspanne der Figur oder der etablierten Epoche/dem Setting – dann das abgeleitete Jahr (notfalls nur das Jahrzehnt) GROSSZÜGIG in datum_year eintragen und datum_unsicher=true setzen. Lieber ein plausibel abgeleitetes (als unsicher markiertes) Jahr als gar keins.
- datum_unsicher=false NUR für explizit im Text belegte Datumsangaben. Ist auch das Jahr nicht erschliessbar, bleibt alles null – Event landet im «unbekannt»-Bucket, wird aber trotzdem aufgenommen.
- Spannen-Events (Krieg, Reise, Studium, Schwangerschaft): Start in datum_year/month/day, Ende in datum_ende_year/month/day. Ein-Punkt-Events lassen datum_ende_* null.
- story_tag: Wenn der Text relative Zeit nutzt («Tag 3», «am dritten Tag der Reise») statt eines Kalenders, hier den INT-Wert eintragen.
- figur_name: exakt wie in figuren[].name dieser Antwort (kanonischen Namen aus der Figurenliste verwenden, KEINE Textvariante, kein Titel, kein Spitzname der dort nicht steht)
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden`;
}

// Split-Schemas für lokale Modelle (Welle 4 · #11). Kleine Modelle werden vom kombinierten
// 5-Array-Schema überfordert. Für Ollama/llama teilen wir die Extraktion in zwei fokussierte
// Pässe auf. Claude bekommt weiterhin den kombinierten Pass.


/** Schema-Block nur für Figuren + Lebensereignisse (Pass A, Lokalmodus). */
function buildKomplettSchemaFigurenOnly(kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Figuren und Lebensereignisse):
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_ASSIGNMENTS_SCHEMA_BLOCK}
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Nur Figuren erfassen, keine Orte/Szenen/Fakten.
- Eindeutige IDs (fig_1, fig_2, …); Beziehungen nur zwischen IDs dieser Liste.
- KONSERVATIV: Nur was im Text eindeutig belegt ist.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: aus ## Header oder Prompt-Kontext. Nie Abschnittstitel.
- figur_name: Klarname exakt wie im Text.
- Ereignisse: datum_label = Original-String, datum_year/month/day strukturiert (null wenn unbekannt). subtyp aus Whitelist; im Zweifel 'sonstiges'.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

${_EREIGNIS_RULES}`;
}

/** Schema-Block nur für Figuren-Stammdaten (OHNE Beziehungen, OHNE Lebensereignisse).
 *  Claude-Single-Pass A1; Beziehungen folgen im A2-Pass, Lebensereignisse im E-Pass
 *  (buildKomplettSchemaEvents) – beides separat, damit A1 das Output-Budget allein den
 *  Stammdaten widmet und Events/Beziehungen nicht darum konkurrieren. */
function buildKomplettSchemaFigurenStamm(kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Figuren-Stammdaten OHNE Beziehungen und OHNE Lebensereignisse):
{
  ${_schemaBody(FIGUREN_STAMM_SCHEMA)}
}`;
  const noBzNote = 'WICHTIG: In DIESEM Pass KEINE Beziehungen und KEINE Lebensereignisse ausgeben (kein beziehungen-Feld, kein assignments-Feld) – beide werden in separaten Pässen erfasst.';
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Nur Figuren-Stammdaten erfassen, keine Orte/Szenen/Fakten, KEINE Beziehungen, KEINE Lebensereignisse.
- Eindeutige IDs (fig_1, fig_2, …).
- KONSERVATIV: Nur was im Text eindeutig belegt ist.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: aus ## Header oder Prompt-Kontext. Nie Abschnittstitel.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

${noBzNote}

Figuren-Regeln:
${figurenBasisRules(kontext)}`;
}

/** Schema-Block nur für Lebensereignisse pro Figur (Claude-Single-Pass E, eigener Call
 *  gegen den gecachten Buchtext-Block). Volle Modell-Aufmerksamkeit auf vollständige
 *  Event-Erfassung – analog zum Fakten-Pass C. */
function buildKomplettSchemaEvents(_kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Lebensereignisse pro Figur):
{
  ${_ASSIGNMENTS_SCHEMA_BLOCK}
}`;
  return `${schemaPart}

${_EREIGNIS_RULES}`;
}

/** Schema-Block für Orte + Songs + (Fakten nur lokal) + Szenen (Pass B).
 *  Claude zieht Fakten in einen eigenen Pass (buildKomplettSchemaFakten) → hier ausgespart;
 *  lokale Provider behalten Fakten im kombinierten Pass B (kein 1h-Cache für einen Extra-Call). */
function buildKomplettSchemaOrteSzenen(_kontext = '') {
  const faktenSchemaLine = _isLocal ? `\n  ${FAKTEN_SCHEMA},` : '';
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Schauplätze, Musikstücke${_isLocal ? ', Fakten' : ''}, Szenen):
{
  ${_schemaBody(ORTE_SCHEMA)},
  ${_schemaBody(SONGS_SCHEMA)},${faktenSchemaLine}
  "szenen": [
    {
      "seite": "NUR der reine Abschnittstitel aus einem ### Header – OHNE ###-Markierung (Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?»). NIE der Kapitelname. Leer wenn unklar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Abschnitts-Header. Leer wenn unklar.",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "Begründung der wertung + Verbesserungshinweis (2-3 Sätze): WARUM ist die Szene stark/mittel/schwach – konkret festgemacht an Spannung, Tempo, Figurenentwicklung, Konflikt/Ziel, Dialog oder Struktur. Bei «mittel»/«schwach» mindestens einen konkreten, umsetzbaren Verbesserungshinweis nennen; bei «stark» benennen, was sie trägt.",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ]
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Keine Figuren-Stammdaten; figuren_namen nur als Klarname-Referenz in Szenen.
- KONSERVATIV: Nur was eindeutig belegt ist.
- kapitel[].name: aus ## Header oder Prompt-Kontext, OHNE «## »-Markierung.
- Szene.seite: reiner Titel eines ### Headers aus dem aktuellen ## Kapitel, OHNE «### »-Markierung. NIE der Kapitelname. Im Zweifel leer.
- Songs: nur mit konkretem Titel oder Interpret aufnehmen; kontext_typ Pflicht.
- Leere Arrays wenn nichts gefunden.`;
  }
  // Claude: Fakten laufen über buildKomplettSchemaFakten – hier keine FAKTEN_RULES.
  return `${schemaPart}

Schauplatz-Regeln:
${ORTE_RULES}

Musik-Regeln:
${SONGS_RULES}

Szenen-Regeln:
- seite: NUR der reine Titel eines ### Headers im aktuellen ## Kapitel, OHNE «### »-Markierung. NIEMALS den Kapitelnamen. Bei Unklarheit: leer.
- figuren_namen: Klarnamen exakt wie im Text; leeres Array wenn keine Figur beteiligt.
- orte_namen: exakter Name wie im Text; leeres Array wenn kein konkreter Ort.
- wertung: «stark» = überzeugend/spannend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen.
- kommentar MUSS die wertung begründen (woran festgemacht) und bei «mittel»/«schwach» einen konkreten Verbesserungshinweis geben – keine reine Zusammenfassung des Inhalts.`;
}

/** Schema-Block nur für Fakten (Claude-Single-Pass C, parallel zu A1/B).
 *  Eigener Call → volle Modell-Aufmerksamkeit auf dichte, vollständige Faktenerfassung,
 *  ohne mit Figuren/Orten/Szenen um das Attention-Budget eines JSON-Outputs zu konkurrieren. */
function buildKomplettSchemaFakten(_kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Fakten):
{
  ${FAKTEN_SCHEMA}
}`;
  return `${schemaPart}

${FAKTEN_RULES}`;
}

// System-Prompt-Builder mit eingebettetem Schema+Regeln-Block (für Caching der parallelen
// Kapitel-Calls über cache_control: ephemeral in lib/ai.js – spart bei ~20 Kapiteln viele
// Schema-Tokens). kontext kommt aus book_settings.buch_kontext (per-Buch-Freitext).
export function buildSystemKomplett(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaStatic(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettFiguren(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaFigurenOnly(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettFigurenStamm(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaFigurenStamm(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettOrteSzenen(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaOrteSzenen(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettFakten(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaFakten(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettEvents(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaEvents(kontext)}${_jsonOnly()}`;
}

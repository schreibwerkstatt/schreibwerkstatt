// Kapitel-Erzählprofil-Prompts (Komplettanalyse-Phase «Erzählprofil»):
// pro Kapitel erkannte Erzählperspektive/-zeit + Erzähler-/Fokusfigur, POV-Konfidenz +
// Beleg, Spannungs-Intensität (Pacing) und dominante Themen/Motive/Symbole.
// Single-Pass (ganzes Buch → Array) + Multi-Pass (ein Kapitel pro Call).
//
// Die perspektive-/erzaehlzeit-Keys sind deckungsgleich mit routes/jobs/narrative-labels.js
// (POV_LABELS/TEMPUS_LABELS) — bei Änderung dort HIER die Legende mitziehen (SSoT-Drift).

// Legende Key → menschliche Beschreibung. Bewusst KEIN Hinweis auf die deklarierte
// Soll-Perspektive des Buchs (kein Anchoring) – das Modell klassifiziert unabhängig,
// die Abweichung wird serverseitig berechnet.
const _POV_LEGENDE = `- «ich» = Ich-Erzähler (1. Person Singular)
- «wir» = Wir-Erzähler (1. Person Plural)
- «du» = Du-Erzähler (2. Person)
- «er_sie_personal» = 3. Person personal (an EINE Figur pro Szene gebunden, keine allwissende Instanz)
- «er_sie_auktorial» = 3. Person auktorial (allwissender Erzähler, Innensicht mehrerer Figuren)
- «gemischt» = innerhalb des Kapitels wechselnde/uneindeutige Perspektiven`;

const _TEMPUS_LEGENDE = `- «praeteritum» = überwiegend Vergangenheit (Präteritum/Imperfekt)
- «praesens» = überwiegend Gegenwart (Präsens)
- «gemischt» = deutlicher Wechsel innerhalb des Kapitels`;

const _PROFIL_FELDER = `Bestimme für JEDES Kapitel:
- perspektive: die dominante Erzählperspektive. Genau EINER dieser Keys:
${_POV_LEGENDE}
- erzaehlzeit: die dominante Erzählzeit. Genau EINER dieser Keys:
${_TEMPUS_LEGENDE}
- erzaehler_figur: Klarname der Erzähler- bzw. Fokusfigur (die Figur, aus deren Sicht erzählt wird) – EXAKT wie im Text. Leer lassen bei auktorialer Perspektive oder wenn keine Figur klar Träger der Sicht ist. KEINE erfundenen Namen.
- pov_konfidenz: 0.0–1.0, wie eindeutig die Perspektive im Kapitel bestimmbar ist (1.0 = völlig eindeutig).
- pov_beleg: kurzes wörtliches Zitat (5–15 Wörter), das die Perspektive belegt (z.B. eine Ich-Formulierung, eine Innensicht). Leer wenn kein prägnanter Beleg.
- intensitaet: dramaturgische Spannungs-/Intensitätsstufe des Kapitels, ganzzahlig 1–5 (1 = ruhig/reflexiv/expositorisch, 2 = ansteigend, 3 = mittlere Spannung, 4 = hohe Spannung/Konflikt, 5 = Höhepunkt/Eskalation/Wendepunkt). Beurteile die erzählerische Wirkung, nicht die Wortzahl.
- intensitaet_begruendung: 1 Satz, warum diese Stufe (was das Kapitel dramaturgisch trägt).
- zusammenfassung: 1 Satz zum erzählerischen Fokus des Kapitels (worum es erzähltechnisch geht).
- themen: die dominanten Themen, Motive und Symbole des Kapitels (je 2–5, absteigend nach Relevanz). Pro Eintrag: thema (kurze Bezeichnung, z.B. «Schuld», «das Meer», «zerbrochene Uhr»), typ («thema» = abstrakter Bedeutungskomplex, «motiv» = wiederkehrendes konkretes Element, «symbol» = bedeutungstragender Gegenstand/Bild), belege (2–4 kurze WÖRTLICHE Zitate aus dem Kapitel, je 3–12 Wörter, die das Thema/Motiv im Text belegen; verschiedene Textstellen, nicht dasselbe Zitat variiert; leeres Array nur, wenn sich wirklich keine Stelle wörtlich zitieren lässt). Nur textbelegte Themen – KEINE Spekulation, KEINE erfundenen oder paraphrasierten Zitate.`;

const _PROFIL_ITEM = `{
      "perspektive": "ich|du|er_sie_personal|er_sie_auktorial|wir|gemischt",
      "erzaehlzeit": "praeteritum|praesens|gemischt",
      "erzaehler_figur": "Klarname der Fokusfigur oder leer",
      "pov_konfidenz": 0.9,
      "pov_beleg": "kurzes wörtliches Zitat oder leer",
      "intensitaet": 3,
      "intensitaet_begruendung": "1 Satz",
      "zusammenfassung": "1 Satz erzählerischer Fokus",
      "themen": [{ "thema": "Bezeichnung", "typ": "thema|motiv|symbol", "belege": ["kurzes wörtliches Zitat", "weiteres Zitat aus anderer Textstelle"] }]
    }`;

/** Single-Pass: das ganze Buch → ein Profil-Eintrag pro Kapitel. `bookText === null`
 *  ⇒ der Buchtext steht im (gecachten) System-Prompt. */
export function buildErzaehlprofilSinglePassPrompt(bookName, bookText) {
  const textBlock = bookText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `Buchtext:\n\n${bookText}`;
  return `Erstelle ein Erzählprofil des Buchs «${bookName}» – pro Kapitel eine Analyse der Erzählweise.

${_PROFIL_FELDER}

WICHTIG: «kapitel» MUSS EXAKT der Kapitelname aus dem jeweiligen «## …»-Header im Text sein (keine Abschnittstitel, keine Nummerierung ergänzen). Gib genau EINEN Eintrag pro Kapitel aus, in Buchreihenfolge.

Antworte mit diesem JSON-Schema:
{
  "kapitel": [
    {
      "kapitel": "Exakter Kapitelname aus dem ## Header",
      ${_PROFIL_ITEM.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '')}
    }
  ]
}

${textBlock}`;
}

/** KI-Dach-Befund («Autoren-Befund»): verdichtet die bereits DETERMINISTISCH berechneten
 *  Struktur-Befunde (befund) zu einer priorisierten Autoren-Einschätzung. Das Modell darf
 *  NUR die gelieferten Kennzahlen benennen/priorisieren/formulieren — es erfindet keine
 *  neuen Befunde und schreibt keinen Buchtext (rein diagnostisch, rückwärtsgewandt). */
export function buildAutorenBefundPrompt(bookName, befund, declared) {
  const decl = [
    declared?.erzaehlperspektive ? `Soll-Perspektive: ${declared.erzaehlperspektive}` : null,
    declared?.erzaehlzeit ? `Soll-Erzählzeit: ${declared.erzaehlzeit}` : null,
  ].filter(Boolean).join(', ');
  return `Du bist Lektor:in und erstellst den «Autoren-Befund» für das Buch «${bookName}» — eine kurze, priorisierte Struktureinschätzung.

Dir liegen DETERMINISTISCH aus dem Manuskript-Katalog berechnete Struktur-Befunde als JSON vor (Figuren-Präsenz/Absenz, Begegnungslücken, Pacing-Kurve, fallengelassene Motive, Ereignis-Dichte, Perspektiv-Konfidenz, Schauplatz-Nutzung). Kapitelangaben sind echte Kapitelnamen.

STRIKTE REGELN:
- Stütze JEDEN Befund AUSSCHLIESSLICH auf die gelieferten Zahlen/Fakten. Erfinde NICHTS, spekuliere nicht über den Inhalt, den du nicht siehst.
- Jeder Befund nennt im Feld «beleg» die konkrete Kennzahl/Stelle, auf der er beruht (z.B. «Anna fehlt Kap. 4–21 (18 Kapitel)», «Spannungstief Kap. 12–16»).
- Sei diagnostisch und rückwärtsgewandt: beschreibe, was strukturell auffällt, ggf. mit einem knappen handwerklichen Hinweis worauf zu achten ist. Schreibe KEINEN Buchtext, keine Szenen, keine Formulierungsvorschläge für das Manuskript.
- Priorisiere: «hoch» nur für strukturell gravierende Muster (z.B. Hauptfigur verschwindet über weite Strecken, behauptete Beziehung ohne gemeinsame Szene, durchgehend flaches Pacing). Redundanzen weglassen.
- Fehlt ein Abschnitt im JSON (z.B. «encounters», «droppedMotifs», «eventDeserts»), wurde er mangels Daten NICHT berechnet: leite daraus KEINEN Befund ab und erwähne ihn nicht. Ein vorhandenes, leeres Array heisst dagegen «geprüft, unauffällig».
- Wenn die Befunde insgesamt unauffällig sind, gib wenige oder keine Einträge zurück und sage das in der Zusammenfassung.
- Höchstens 8 Befunde.
${decl ? `\nDeklarierte Erzählform: ${decl}\n` : ''}
Antworte mit diesem JSON-Schema:
{
  "zusammenfassung": "1–3 Sätze Gesamteinschätzung der Struktur",
  "befunde": [
    { "kategorie": "figuren|pacing|struktur|perspektive|kohaerenz|thema|orte|dramaturgie", "prio": "hoch|mittel|niedrig", "titel": "kurze Überschrift", "text": "die Beobachtung", "beleg": "die konkrete Kennzahl/Stelle" }
  ]
}

Struktur-Befunde (JSON):
${JSON.stringify(befund)}`;
}

/** Multi-Pass: ein einzelnes Kapitel → ein Profil-Objekt (Kapitelname ist bekannt). */
export function buildErzaehlprofilChapterPrompt(bookName, chapterName, chText) {
  return `Analysiere die Erzählweise des Kapitels «${chapterName}» aus dem Buch «${bookName}».

${_PROFIL_FELDER}

Antworte mit diesem JSON-Schema (genau EIN Objekt für dieses Kapitel):
${_PROFIL_ITEM}

Kapiteltext:

${chText}`;
}

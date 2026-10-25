// Ausgabe des agentischen Buch-Chats: der Pflicht-Endpunkt `final_answer` und die
// Regel für Fragen zur Aussenwelt. Die Lese-Werkzeuge kommen aus dem gemeinsamen
// Katalog (./chat-tools/), Format und Regeln dort (./chat-tools/CLAUDE.md).

import { toolMentions } from './chat-tools/mentions.js';

export const BOOK_CHAT_OUTPUT_TOOLS = [
  {
    name: 'final_answer',
    description: 'Liefert die Antwort an den User — Pflicht-Endpunkt und ALLERLETZTER Aufruf einer Runde; Freitext ohne final_answer gilt nicht als Antwort. Sprache: die der Userfrage. Jedes wörtliche Zitat der antwort gehört mit {page_id, offset, length, quote} in `zitate`; der Server prüft sie und zeigt sie als Fussnoten. Reale Fakten AUSSERHALB des Manuskripts kannst du nicht prüfen (keine Web-Suche): sag das, beantworte, was das Buch hergibt, und setze recherche_hinweis mit einer präzisen recherche_frage. Bemerkst du einen Widerspruch, Fehler oder offenen Punkt an einer konkreten Stelle, biete ihn in `ideen` an.',
    see: {
      quote_passage: 'Die Zitat-Koordinaten liefert `quote_passage`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User als Freitext, Markdown erlaubt. Pflichtfeld.' },
        zitate: {
          type: 'array',
          description: 'Alle wörtlichen Zitate der antwort. Halluzinationsschutz: der Server prüft text.slice(offset, offset+length) == quote im aktuellen Abschnittstext.',
          items: {
            type: 'object',
            properties: {
              page_id: { type: 'integer', description: 'Abschnitts-ID des Zitats.' },
              offset:  { type: 'integer', description: 'Start-Offset im Plain-Text (>= 0).' },
              length:  { type: 'integer', description: 'Länge des Zitats in Zeichen (> 0).' },
              quote:   { type: 'string',  description: 'Der exakt zitierte Text (zeichengenau zum Abschnittsinhalt).' },
            },
            required: ['page_id', 'offset', 'length', 'quote'],
          },
        },
        recherche_hinweis: { type: 'boolean', description: 'true, wenn die Frage (auch) reale Fakten ausserhalb des Manuskripts betrifft, die nur eine Web-Recherche klären kann.' },
        recherche_frage:   { type: 'string',  description: 'Mit recherche_hinweis: die Frage, eigenständig formuliert, wie sie der Recherche-Chat bekommen soll.' },
        ideen: {
          type: 'array',
          description: 'Höchstens 3 Pendenzen, die der Autor als Idee festhalten kann (er bestätigt jede einzeln): ein bemerkter Widerspruch, Fehler, offener Punkt — oder etwas, das er notieren lassen will. Anker GENAU EINER: page_id des Abschnitts, an dem die Korrektur ansetzt, ODER chapter_id für einen kapitelweiten Punkt. Nichts, was schon offen in der Ideenliste steht.',
          items: {
            type: 'object',
            required: ['inhalt'],
            properties: {
              page_id:     { type: 'integer', description: 'Abschnitts-ID des Ankers (aus einem Werkzeug-Ergebnis, nicht geraten).' },
              chapter_id:  { type: 'integer', description: 'Statt page_id: Kapitel-ID des Ankers.' },
              inhalt:      { type: 'string',  description: 'Knapper, eigenständig verständlicher Stichpunkt ohne Bezug auf diesen Chat, z.B. «Augenfarbe von Lena: hier grün, in Kapitel 2 blau — vereinheitlichen».' },
              begruendung: { type: 'string',  description: 'Optional: kurz, was du bemerkt hast.' },
            },
          },
        },
      },
      required: ['antwort'],
    },
  },
];

/**
 * Regel für Fragen zur Aussenwelt — hängt der Job (routes/jobs/chat/book-chat-agent.js)
 * an den stabilen System-Block 1. Der Buch-Chat hat KEINE Web-Suche; ohne diese
 * Regel beantwortet das Modell reale Fakten aus seinem Trainingswissen, und die
 * Antwort sieht aus wie ein Befund aus dem Manuskript.
 * @param {string[]} [toolNames]  angebotene Werkzeuge (Mentions-Filter)
 */
export function buildBookChatOutsideWorldRule(toolNames) {
  const m = toolMentions(toolNames);
  const research = m.list(['list_research_items', 'read_research_item'], '/');
  return [
    'AUSSENWELT: Du hast KEINE Web-Suche und kein Wissen ausser dem Manuskript und den Index-Werkzeugen.',
    'Betrifft eine Frage reale Ereignisse, Orte, Personen oder Fakten ausserhalb des Buchs (z.B. «stimmt das historisch?», «wann fiel die Mauer wirklich?»), sag klar, dass der Buch-Chat das nicht prüfen kann, und verweise auf den Recherche-Chat.',
    'Setze dann in `final_answer` `recherche_hinweis: true` und `recherche_frage` (eigenständig formuliert, ohne Bezug auf diesen Chat). Was das Manuskript selbst dazu sagt, beantwortest du trotzdem.',
    ...(research ? [`Ausnahme: was der Autor selbst recherchiert hat, steht im Recherche-Archiv (${research}). Das darfst du heranziehen — kennzeichne es als gesammeltes Material des Autors, nicht als geprüfte Tatsache und nicht als Buchstelle.`] : []),
    'Ausnahme: allgemeine Lebensnormen (Einschulung mit etwa 6 Jahren, Volljährigkeit mit 18, übliches Pensionsalter, Schwangerschaftsdauer u.ä.) darfst du als PRÜFMASSSTAB an die Daten des Buchs anlegen, z.B. «wann sollte X eingeschult werden?» oder «passt das Alter von X zu diesem Ereignis?». Kennzeichne die Norm als Allgemeinwissen (nicht als Buchstelle) und nenne, dass sie je nach Land und Epoche abweichen kann'
      + (m.has('get_figure_age') ? '; Alter rechnest du dabei mit `get_figure_age`.' : '.')
      + ' Das ist kein Fall für den Recherche-Chat — setze `recherche_hinweis` nur, wenn die Antwort an einer konkreten historischen oder regionalen Tatsache hängt.',
  ].join('\n');
}

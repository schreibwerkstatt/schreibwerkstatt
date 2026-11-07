// Welcher agentische Chat welches Lese-Werkzeug bekommt — eine Tabelle für alle
// vier Chats mit Werkzeugen. Ein neues Werkzeug bekommt hier eine Zeile und damit
// die Entscheidung für jeden Chat an einer Stelle.
//
// Wert je Chat: 'slim' = auch im Slim-Satz (lokale Provider: kein Prompt-Caching,
// kleineres Modell, jede Runde zahlt den ganzen Werkzeug-Block neu), 'full' = nur
// im vollen Satz, fehlt = nicht angeboten. Zusätzlich fällt zur Laufzeit weg, was
// im Buch keine Daten hat oder einen fehlenden Endpunkt braucht
// (routes/jobs/chat-tools/index.js#AVAILABILITY).
//
// Schwerpunkte: Buch-Chat = alles, was Fragen zum Buch beantwortet; Plot-Chat =
// ohne Stil-/Lektorat-/Revisions-/Bild-Werkzeuge (beantworten keine Plotfrage);
// Ideen-Chat = Text (Erledigt-Check, Ortssuche) + planende Kataloge, an denen
// eine Idee hängt — Gliederung und Ideen stehen im Vorspann (`list_ideen` hält der
// Job zurück, solange die Ideenliste dort ungekürzt ist);
// Recherche-Chat = Archiv + Literatur-Register + kompakte Welt-Übersicht, dazu
// die Wortlaut-Suche für den Beleg einer Status-Änderung.
// Gegated: tests/unit/chat-tools-contract.test.mjs.

const S = 'slim';
const F = 'full';

export const CHAT_KINDS = ['book', 'plot', 'ideen', 'research'];

export const CHAT_TOOL_ACCESS = {
  // Text
  // Ideen-Chat ohne: die Gliederung mit Kennungen steht im Vorspann.
  list_chapters:            { book: S, plot: S },
  // Recherche-Chat: der Beleg eines «eingearbeitet» steht im Manuskript. Nur auf
  // dem Suchweg ohne Seitenlesen angeboten (routes/jobs/research-chat.js, `withhold`).
  search_passages:          { book: S, plot: S, ideen: S, research: F },
  search_similar:           { book: S, plot: S, ideen: S },
  // Plot-Chat: Einzelabschnitte im Slim-Satz, ganze Kapitel nur im vollen — die
  // Kosten-Leiter (Passage → Abschnitt → Kapitel) gilt auch hier.
  get_pages:                { book: S, plot: S, ideen: S },
  get_chapter_text:         { book: S, plot: F, ideen: S },
  // Ideen-Chat: der Beleg eines «erledigt» muss wörtlich stimmen.
  quote_passage:            { book: S, ideen: F },
  get_dialogue:             { book: F },
  find_repetitions:         { book: F },
  // Welt
  // Plot-Chat: die Figurenliste mit Kennungen steht schon im Vorspann — im
  // Slim-Satz wäre das Werkzeug doppelt bezahlt.
  list_figures:             { book: S, plot: F, ideen: S },
  get_figure_profile:       { book: S, plot: S, ideen: F },
  get_figure_mentions:      { book: S, plot: F, ideen: F },
  get_figure_relations:     { book: S, plot: F },
  // Alter/Jahrgang ist die häufigste schmale Faktenfrage — und genau die Rechnung,
  // bei der ein kleines Modell sich verrechnet.
  get_figure_age:           { book: S, plot: F },
  // Recherche-Chat: welche Daten das Buch schon setzt, bevor es gegen die Welt prüft.
  get_timeline:             { book: S, plot: F, ideen: F, research: F },
  list_scenes:              { book: S, plot: S, ideen: F },
  list_locations:           { book: S, plot: F, ideen: F },
  // Plot-Chat ohne: Schauplätze samt Elternort stehen im Vorspann, list_locations
  // trägt den Rest.
  get_location_profile:     { book: F },
  // Schon verdichtete Aussagen statt Passagen (Stufe 2 der Kosten-Leiter): ohne
  // Welt-Fakten, Kontinuitätsbefunde, Ideen und Doppelungen eskaliert ein kleines
  // Modell für «welche Regel gilt hier», «wo sind Widersprüche?», «was fehlt noch?»,
  // «was erzähle ich doppelt?» auf Kapitel-Volltexte und übergeht erhobene Befunde.
  list_world_facts:         { book: S, plot: S, ideen: F, research: F },
  list_songs:               { book: F },
  list_continuity_issues:   { book: S, plot: F, ideen: F },
  // Befunde und Messungen
  get_reviews:              { book: S, plot: F, ideen: F },
  get_lektorat:             { book: F },
  get_stil_metrics:         { book: F },
  // Plot-Chat: ob ein neuer Beat in einer Rohfassung oder in einem abgeschlossenen
  // Kapitel landet.
  get_edit_status:          { book: F, plot: F },
  list_redundancies:        { book: S, ideen: F },
  list_revisions:           { book: F },
  get_book_settings:        { book: F },
  search_chat_history:      { book: F },
  // Planung und Material
  // Plot-Chat: der Job hält es zurück, solange das Board ungekürzt im Vorspann steht.
  get_plot_board:           { book: F, plot: S, ideen: S },
  get_motifs:               { book: F, plot: F, ideen: F },
  list_werkstatt_drafts:    { book: F, plot: S, ideen: F },
  list_ideen:               { book: S, plot: F, ideen: S },
  list_research_items:      { book: F, ideen: F, research: S },
  read_research_item:       { book: F, ideen: F, research: S },
  search_research_passages: { book: F, ideen: F, research: S },
  lookup_literature:        { research: S },
  list_book_entities:       { research: S },
  generate_image:           { book: S },
};

/** Namen der Lese-Werkzeuge, die `chat` bekommt (Slim-Satz oder voller Satz), in Tabellen-Reihenfolge. */
export function chatToolNames(chat, { slim = false } = {}) {
  return Object.keys(CHAT_TOOL_ACCESS).filter(name => {
    const level = CHAT_TOOL_ACCESS[name][chat];
    return level === S || (level === F && !slim);
  });
}

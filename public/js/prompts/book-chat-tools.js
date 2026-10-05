// Werkzeug-Definitionen für den Agentic Buch-Chat (aus chat.js ausgelagert).
// Anthropic-Tool-Format (name/description/input_schema). lib/ai.js liest daraus direkt.
// Beschreibungen bewusst kurz — kosten Input-Tokens.
// Übersicht aller Tools: docs/buchchat-tools.md

export const BOOK_CHAT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Liefert die Kapitel- und Abschnittsliste: vorne total_chapters/total_pages/total_words/hint, dann pro Kapitel chapter_id, Name, Wortzahl und pages (= Abschnitte) als Tupel [page_id, page_name, words] (siehe page_format). Bei grossen Büchern paginiert: steht next_offset im Ergebnis, mit offset=next_offset weiterblättern. Nutze dies für einen Überblick – und um page_ids für get_pages zu bekommen. Nicht nutzen für Detailstatistik eines einzelnen Kapitels (Dialoganteil, Top-Figuren-Erwähnungen) – dafür `get_stil_metrics` (scope=chapter, include_figures).',
    input_schema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', description: 'Optional: erstes Kapitel (0-basiert, default 0). Aus next_offset übernehmen.' },
        limit:  { type: 'integer', description: 'Optional: max. Anzahl Kapitel (default alle, die in die Antwort passen).' },
      },
      required: [],
    },
  },
  {
    name: 'list_figures',
    description: 'Flacher Figurenkatalog des Buchs: pro Figur fig_id, Name, Kurzname, Typ, Rolle, Präsenz und Gesamt-Erwähnungen (aus Index). Leichtgewichtig – ideal als Einstieg, um zu wissen, welche Figuren existieren und welche IDs für die anderen Figuren-Tools nötig sind. Nicht nutzen für Detail einer Figur (Profil, Beziehungen, Lebensereignisse) – dafür `get_figure_profile`.',
    input_schema: {
      type: 'object',
      properties: {
        sort:  { type: 'string', enum: ['mentions_desc', 'name', 'presence_desc'], description: 'Reihenfolge. Default: mentions_desc (häufigste zuerst).' },
        limit: { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'count_pronouns',
    description: 'Zählt Pronomen im ganzen Buch (Summe) oder pro Kapitel (per_chapter=true). Unterscheidet narrativen Text und Dialog. Ideal für Fragen zur Erzählperspektive ("kommt der Ich-Erzähler häufiger vor?").',
    input_schema: {
      type: 'object',
      properties: {
        per_chapter: { type: 'boolean', description: 'true = pro Kapitel aufschlüsseln, false = gesamt (default).' },
        pronouns: {
          type: 'array',
          items: { type: 'string', enum: ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'] },
          description: 'Optionaler Filter auf bestimmte Pronomen-Gruppen. Ohne Angabe: alle.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft wird eine Figur erwähnt? Antwort nach Kapitel und Abschnitt, mit Count je Abschnitt. Liefert ausserdem `first_appearance`, `last_appearance`, `total_mentions`, `pages_with_mention` – deckt Arc-Tracking-Fragen ("wann zuerst, wann zuletzt?", "wie lange präsent?") direkt ab. Leichtgewichtig – nur Auftrittsverteilung. Nicht nutzen für Profil, Beziehungen oder Lebensereignisse von X – dafür `get_figure_profile`. Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id aus der Figurenliste (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name oder Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'search_passages',
    description: 'Durchsucht den Buch-Volltext via FTS5 (Literal-Pfad, bm25-sortiert) und liefert exakte Treffer-Offsets + Snippets. Standard: case-insensitive Literal-Suche; mit regex=true als JavaScript-Regex (umgeht FTS5 und scannt alle Abschnitte direkt). Mit chapter_id/page_id auf ein Kapitel oder einen Abschnitt einschränken. Offsets sind kompatibel mit `quote_passage`. Nutze dies für "wo kommt X vor?"-Fragen über das ganze Buch, wenn X ein KONKRETES Wort/Name/eine Phrase ist. NICHT nutzen, um Stellen nach einer Eigenschaft zu finden, die nicht im Wortlaut steht — rate dann keine Stichwörter: Beispiele für ein Stilmittel, eine Stimmung, ein Motiv, „Stellen über X“ in eigenen Worten → zuerst `search_similar`; Auswahl oder Vollständigkeit über den ganzen Text (lustigste Stelle, ALLE Stellen zu X, Zusammenfassung) → Kapitel lesen via `get_chapter_text` (gebündelt). Auch nicht nutzen, wenn du bereits page_ids kennst und den vollen Abschnittstext brauchst (→ `get_pages` / `get_chapter_text`) oder für Figuren-Auftritte (→ `get_figure_mentions`).',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Suchmuster (literal oder Regex). Im Literal-Modus ist dies eine PHRASEN-Suche, KEINE Stichwort-ODER-Suche: mehrere Wörter werden als exakte Wortfolge gesucht (FTS5 filtert die Abschnitte nur vor). „lustig komisch witzig" matcht also nur diese Wortfolge, nicht Abschnitte, die irgendeines der Wörter enthalten. Suche nach EINEM konkreten Wort/Namen/einer festen Phrase; für Stellen nach Sinn ist das Tool ungeeignet (→ `search_similar`). Mehrere Alternativen brauchst du regex=true (z.B. `lustig|komisch|witzig`).' },
        regex:       { type: 'boolean', description: 'true = pattern als JavaScript-Regex interpretieren, scannt alle Abschnitte des Buchs ohne FTS5-Vorfilter. Default: false.' },
        chapter_id:  { type: 'integer', description: 'Optional: Suche auf ein Kapitel einschränken.' },
        page_id:     { type: 'integer', description: 'Optional: Suche auf einen einzelnen Abschnitt einschränken (überschreibt chapter_id-Wirkung).' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_similar',
    description: 'Semantische Ähnlichkeitssuche (Embeddings) über das ganze Buch: findet Passagen, Szenen, Figuren, Orte und Welt-Fakten, die einem Suchtext BEDEUTUNGSMÄSSIG nahestehen — auch mit anderen Wörtern. ERSTE WAHL für Suchen nach Eigenschaft oder Sinn: Beispiele für ein Stilmittel, eine Stimmung, ein Motiv, „Stellen über X“ als Umschreibung („wo herrscht dieselbe resignierte Stimmung“, „Szenen wie ein Abschied am Bahnhof“). Für konkrete Wörter/Namen → `search_passages`; für Superlative oder Vollständigkeit über den ganzen Text (lustigste Stelle, ALLE Stellen, Zusammenfassung) → Kapitel lesen via `get_chapter_text`. Liefert nach Relevanz sortierte Treffer {kind,entity_id,title,snippet,score}; der Ausschnitt ist um den passendsten Satz zentriert. Abschnitts-Treffer (kind=page) tragen zusätzlich chapter_name und, wenn die Stelle im aktuellen Abschnittstext gefunden wird, offset/length (kompatibel mit `quote_passage`, dort max. 800 Zeichen). Der Ausschnitt ist oft schon die Antwort — dann NICHT noch `get_pages`/`get_chapter_text` nachschieben. Rein rückwärtsgewandt — findet Bestehendes, erfindet nichts.',
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string',  description: 'Freitext, dessen Bedeutung gesucht wird (eine Beschreibung, ein Beispielsatz, ein Motiv). Für Stichwortsuche stattdessen `search_passages`.' },
        kinds:   { type: 'array', items: { type: 'string', enum: ['page', 'scene', 'figure', 'location', 'fact', 'research'] }, description: 'Optional: auf Treffertypen einschränken (Abschnitte [page]/Szenen/Figuren/Orte/Welt-Fakten; `research` = Recherche-Material des Autors, nur auf ausdrücklichen Wunsch). Default: alle ausser research.' },
        limit:   { type: 'integer', description: 'Maximale Trefferzahl (default 20, max 50). Bei grossem snippet_chars kleiner wählen (z.B. 6–10) — sonst kürzt der Server die Liste.' },
        snippet_chars: { type: 'integer', description: 'Länge des Textausschnitts pro Treffer (default 700, max 1500 ≈ eine ganze indizierte Passage). Bei Suchen nach Eigenschaft/Stimmung/Stilmittel gross wählen (1200–1500) und limit klein (6–10) — der Ausschnitt soll die Stelle selbst zeigen und ersetzt ein teures get_pages danach.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_pages',
    description: 'Lädt den vollen Text bestimmter Abschnitte (bei Bedarf für Zitate oder Detail-Analyse). Bis zu 20 Abschnitte pro Aufruf – bei kleinen Büchern kannst du in einem Call das ganze Buch laden (page_ids vorher via list_chapters holen). Falls für den Abschnitt ein gespeichertes Lektorat existiert, kommt es als latest_check {checked_at, error_count, fazit, stilanalyse} mit. Schwergewichtig (Volltext) – nicht nutzen für blosse Trefferlisten oder „wo kommt X vor?", dafür `search_passages` / `get_figure_mentions`. Für ein ganzes Kapitel bequemer: `get_chapter_text`. Nicht zur Massen-Inspektion ganzer Bücher aufrufen, wenn ein Aggregat-Tool (z.B. `get_stil_metrics`, `get_lektorat_hotspots`) die Frage direkt beantwortet.',
    input_schema: {
      type: 'object',
      properties: {
        ids:                { type: 'array', items: { type: 'integer' }, description: 'Liste der page_ids (aus list_chapters oder anderen Tool-Ergebnissen).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Abschnitt. Server clamped automatisch an das Kontextfenster – nur setzen, wenn explizit weniger gewünscht.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_chapter_text',
    description: 'Lädt den Volltext aller Abschnitte eines Kapitels in einem Call (max 20 Abschnitte, automatische Sortierung nach page_id). Spart die Sequenz list_chapters → get_pages. Liefert pages[{page_id,page_name,text,truncated}] + total_pages. Ideal für "fasse Kapitel X zusammen", "wie endet Kapitel 3?", "welche Szenen sind in Kapitel 2?". Falls das Kapitel >20 Abschnitte hat, kommt `dropped` zurück — restliche Abschnitte dann gezielt via `get_pages` nachladen.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id:         { type: 'integer', description: 'Kapitel-ID aus list_chapters (Pflicht).' },
        max_pages:          { type: 'integer', description: 'Anzahl Abschnitte max. (1-20, Default: alle Abschnitte des Kapitels bis 20).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Abschnitt. Server clamped automatisch ans Kontextfenster.' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'get_reviews',
    description: 'Liefert gespeicherte Bewertungen für dieses Buch und diesen User. `scope="book"`: letzte Buchbewertung (gesamtnote 1.0–6.0, Stärken/Schwächen/Fazit/Zusammenfassung). `scope="chapter"` (Default): Liste der Kapitelbewertungen — pro Kapitel gesamtnote, Stärken, Schwächen, Fazit, Zusammenfassung; plus `ohne_bewertung[]` für noch nicht bewertete Kapitel. Antwortet ohne weiteren KI-Call. Beantwortet "wie gut ist das Buch insgesamt?" (book) bzw. "welche Kapitel sind am stärksten/schwächsten?" (chapter).',
    input_schema: {
      type: 'object',
      properties: {
        scope:       { type: 'string', enum: ['book', 'chapter'], description: 'Aggregations-Scope. Default: chapter.' },
        chapter_ids: { type: 'array', items: { type: 'integer' }, description: 'Nur für scope=chapter: filtert auf diese Kapitel-IDs. Ohne Angabe: alle bewerteten Kapitel.' },
        sort:        { type: 'string', enum: ['note_desc', 'note_asc', 'chapter'], description: 'Nur für scope=chapter. Default: note_desc (stärkste zuerst).' },
        limit:       { type: 'integer', description: 'Nur für scope=chapter. Default 30, max 100.' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_relations',
    description: 'Liefert das Soziogramm: alle Figurenbeziehungen als gerichtete Kanten (from → to) mit Typ, Beschreibung, Machtverhältnis und bis zu 3 Belegen. Ohne Filter: ganzes Buch. Mit figur_id/figur_name: nur Kanten, die diese Figur berühren. Ideal für "wer kennt wen?", "Konflikte zwischen X und Y", "wer dominiert?".',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Kanten dieser Figur (fig_id, z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_profile',
    description: 'Vollständiges Profil einer Figur: Stammdaten (Typ, Geburtstag, Beruf, Rolle, Motivation, Konflikt, Entwicklung, Sozialschicht, Präsenz), Tags, Schlüsselzitate, alle Lebensereignisse (mit Kapitel/Abschnitt), Szenen, Kapitel-Auftritte und alle Beziehungen (beide Richtungen). Schwergewichtig — für "was weißt du über X?" oder Detail-Analyse einer Figur. Enthält bereits Beziehungen – kein zusätzliches `get_figure_relations` nötig. Nicht nutzen, wenn nur Auftrittsverteilung gefragt ist (→ `get_figure_mentions`) oder nur Kanten zwischen mehreren Figuren (→ `get_figure_relations` ohne Filter). Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname.' },
      },
      required: [],
    },
  },
  {
    name: 'list_continuity_issues',
    description: 'Listet die Befunde des letzten Kontinuitätschecks: pro Issue Typ, Schwere, Beschreibung, betroffene Stellen (stelle_a/stelle_b), Empfehlung sowie betroffene Figuren und Kapitel. Beantwortet "wo widerspricht sich das Buch?", "was sind die schwersten Lücken?", "Kontinuitätsprobleme in Kapitel X". Liefert nichts, wenn noch kein Check ausgeführt wurde.',
    input_schema: {
      type: 'object',
      properties: {
        schwere:    { type: 'string', description: 'Optionaler Filter (z.B. "hoch", "mittel", "niedrig"). Vergleich case-insensitive.' },
        typ:        { type: 'string', description: 'Optionaler Typ-Filter (z.B. "zeit", "ort", "fakt"). Vergleich case-insensitive.' },
        chapter_id: { type: 'integer', description: 'Nur Issues, die dieses Kapitel betreffen.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 30, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'get_timeline',
    description: 'Liefert den konsolidierten Zeitstrahl (zeitstrahl_events) chronologisch nach sort_order: Datum, Ereignis, Typ, Bedeutung, betroffene Kapitel/Abschnitte/Figuren. Mit figur_id/figur_name filtert auf Ereignisse, an denen diese Figur beteiligt ist. Mit typ filtert auf Ereignistyp (z.B. "persoenlich", "historisch"). Ideal für "wann passiert was?", "biografische Timeline von X".',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Ereignisse dieser Figur (fig_id).' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname der Figur.' },
        typ:        { type: 'string', description: 'Optional: Typ-Filter (case-insensitive).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 60, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_age',
    description: 'Alter bzw. Jahrgang einer Figur — deterministisch im Server gerechnet, nicht von dir. Liefert Geburtsjahr (mit Quelle), wörtliche Altersangaben aus dem Text (Alters-Index) und, mit `jahr` oder `ereignis`, das Alter zu diesem Jahr bzw. zu den passenden datierten Ereignissen des Zeitstrahls. Ideal für „wie alt war X, als Y passierte?", „wie alt ist X 1989?", „welcher Jahrgang ist X?". Rechne Alter NIE selbst aus Jahreszahlen — nutze dieses Werkzeug.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string',  description: 'fig_id der Figur.' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname der Figur.' },
        jahr:       { type: 'integer', description: 'Optional: Kalenderjahr, für das das Alter gerechnet wird.' },
        ereignis:   { type: 'string',  description: 'Optional: Stichwort eines Ereignisses (Teilstring, z.B. "Mauerfall", "Hochzeit"); gesucht in den datierten Zeitstrahl-Ereignissen.' },
      },
      required: [],
    },
  },
  {
    name: 'list_ideen',
    description: 'Listet die Notizen/Ideen/Pendenzen, die der User zu einzelnen Abschnitten oder ganzen Kapiteln gespeichert hat (mit Kapitel-/Abschnittskontext). Jede Idee hat `scope: "page"` (Abschnitt), `"chapter"` oder `"book"` (noch keiner Stelle zugeordnet) und einen `status`: offen → in_arbeit → erledigt, daneben verworfen. VERWORFEN heisst: der Autor hat sie geprüft und sich dagegen entschieden — schlage sie nicht erneut vor. Ideal um offene Anmerkungen aufzugreifen, oder zu beantworten "was wollte ich an Kapitel X noch ändern?". Filterbar nach status bzw. offen_only, page_id, chapter_id (Chapter-Filter umfasst sowohl direkt-am-Kapitel-Ideen als auch Ideen zu Abschnitten des Kapitels). Noch offene Ideen erscheinen zuerst. `verknuepft` nennt, woran eine Idee planerisch hängt (art = beat/motif/research/…, mit id + label) — beantwortet "welche Pendenzen hängen an Beat/Motiv/Fundstück X?".',
    input_schema: {
      type: 'object',
      properties: {
        status:     { type: 'string', enum: ['offen', 'in_arbeit', 'erledigt', 'verworfen'], description: 'Nur Ideen dieser Stufe.' },
        offen_only: { type: 'boolean', description: 'true = nur noch offene (offen ODER in_arbeit). Abkürzung statt zweier status-Aufrufe.' },
        page_id:    { type: 'integer', description: 'Nur Ideen zu diesem Abschnitt.' },
        chapter_id: { type: 'integer', description: 'Nur Ideen zu diesem Kapitel (direkt-am-Kapitel + Abschnitte des Kapitels).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_research_items',
    description: 'Listet das Recherche-Board des Buchs: vom Autor gesammelte Fakten, Zitate, Links, Notizen, PDFs und Interviews (id, kind, status, Titel, Kurztext, Tags). `stellen` nennt die Kapitel/Abschnitte, mit denen ein Fundstück verknüpft ist, `bezug` die Figuren/Orte/Szenen. `status`: offen → in_arbeit → eingearbeitet, daneben verworfen (geprüft, bewusst nicht verwendet). Beantwortet "was habe ich zu X recherchiert?", "welche Fakten gehören zu Kapitel 3?", "was ist noch nicht eingearbeitet?". Filter: q (Volltext), kind, status, chapter_id (Kapitel + seine Abschnitte), page_id. Das Board ist Material des Autors, KEIN Manuskripttext — zitiere daraus nie als Buchstelle.',
    input_schema: {
      type: 'object',
      properties: {
        q:          { type: 'string', description: 'Optionale Volltextsuche.' },
        kind:       { type: 'string', enum: ['note', 'link', 'quote', 'fact', 'image', 'document', 'transcript'], description: 'Optionaler Typfilter.' },
        status:     { type: 'string', enum: ['offen', 'in_arbeit', 'eingearbeitet', 'verworfen'], description: 'Nur Fundstücke dieser Stufe.' },
        chapter_id: { type: 'integer', description: 'Nur Fundstücke an diesem Kapitel oder an einem seiner Abschnitte.' },
        page_id:    { type: 'integer', description: 'Nur Fundstücke an diesem Abschnitt.' },
      },
      required: [],
    },
  },
  {
    name: 'read_research_item',
    description: 'Volltext EINES Recherche-Fundstücks: Titel, Inhalt, URLs, Quelle, Tags, Status, Verknüpfungen und bei angehängtem PDF den Anfang des Dokumenttexts (Kappung wird ausgewiesen). Nutze es, um einen Fakt aus dem Board mit dem Manuskript abzugleichen.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id aus list_research_items.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_lektorat_hotspots',
    description: 'Aggregat über page_checks (letzter Check pro Abschnitt): pro Kapitel total/avg/max Fehleranzahl plus Top-N-Abschnitte mit den meisten Fehlern (inkl. fazit-Snippet). Beantwortet "wo sind die schwersten Lektorat-Probleme?", "welche Kapitel brauchen am meisten Arbeit?". Schneller Überblick. Nutze danach `get_lektorat_findings` für die konkreten Findings eines Abschnitts/Kapitels. Nicht nutzen für Stil-/Lesbarkeitsmetriken (Passiv-Anteil, LIX, Dialoganteil) – dafür `get_stil_metrics`. Hotspots zählen Fehler-Findings; Metriken messen Satzstruktur.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Abschnitte dieses Kapitels.' },
        min_errors: { type: 'integer', description: 'Mindest-Fehleranzahl pro Abschnitt (default 0).' },
        limit:      { type: 'integer', description: 'Anzahl Top-Abschnitte (default 20, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'get_lektorat_findings',
    description: 'Konkrete Lektorat-Findings (Einzelbefunde, nicht nur Aggregat). Liefert findings[{page_id,page_name,chapter_id,chapter_name,checked_at,typ,original,korrektur,erklaerung,offset?,length?}] aus dem letzten Check pro Abschnitt. Plus by_typ-Verteilung und total_findings. Filterbar nach page_id, chapter_id und typ (z.B. "stil","grammatik","rechtschreibung","interpunktion","fluss","wortwahl"). Ideal für "welche Stilfehler gibt es im Kapitel?", "zeig mir konkrete Lektorat-Vorschläge zu Abschnitt X", "wo wurden Grammatikfehler gefunden?". Vorlauf: `get_lektorat_hotspots` für Überblick, dann hier ins Detail.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:    { type: 'integer', description: 'Nur Findings dieses Abschnitts.' },
        chapter_id: { type: 'integer', description: 'Nur Findings dieses Kapitels (ignoriert wenn page_id gesetzt).' },
        typ:        { type: 'string',  description: 'Optional: Filter nach Fehler-Typ (case-insensitive, z.B. "stil").' },
        limit:      { type: 'integer', description: 'Max. Findings im Output (default 30, max 100). Aggregate (by_typ, total_findings) zählen alle Treffer.' },
      },
      required: [],
    },
  },
  {
    name: 'get_stil_metrics',
    description: 'Stil- und Lesbarkeitsmetriken aus page_stats. Drei Modi via scope: "book" (Aggregat über das ganze Buch), "chapter" (Aufschlüsselung pro Kapitel, optional gefiltert via chapter_id), "page" (Top-N-Abschnitte nach einer Metrik). Liefert words/chars/sentences/dialog_chars/dialog_ratio_percent/filler_count/passive_count/adverb_count/avg_sentence_len/sentence_len_p90/lix/flesch_de. Mit `include_figures=true` (nur scope=chapter) kommen pro Kapitel Top-5-Figuren-Erwähnungen mit. Ideal für "wie viel Passiv im Buch?", "welche Kapitel haben am meisten Dialog?", "welche Abschnitte haben höchsten LIX?", "wer ist in Kapitel X am häufigsten?". Nicht nutzen für Fehleranzahl/Lektorat-Hotspots – dafür `get_lektorat_hotspots`.',
    input_schema: {
      type: 'object',
      properties: {
        scope:           { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Aggregations-Scope. Default: book.' },
        chapter_id:      { type: 'integer', description: 'Nur für scope=chapter: einzelnes Kapitel statt aller.' },
        include_figures: { type: 'boolean', description: 'Nur für scope=chapter: hängt pro Kapitel `top_figuren` (max 5) an.' },
        metric:          {
          type: 'string',
          enum: ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'],
          description: 'Nur für scope=page: nach welcher Metrik sortiert wird. Default: passive_count.',
        },
        order:           { type: 'string', enum: ['asc', 'desc'], description: 'Nur für scope=page: Sortier-Richtung. Default: desc (höchster Wert zuerst).' },
        limit:           { type: 'integer', description: 'Nur für scope=page: Anzahl Abschnitte (default 10, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'list_locations',
    description: 'Liefert alle Schauplätze/Orte des Buchs: Name, Typ, Beschreibung, Stimmung, erste Erwähnung, betroffene Kapitel (mit Häufigkeit), `last_chapter` (kapitel-genaues Arc-Ende), assoziierte Figuren. Pendant zu Figurenliste, aber für Orte. Filterbar nach chapter_id (nur Orte, die in diesem Kapitel vorkommen).',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Orte, die in diesem Kapitel auftauchen.' },
      },
      required: [],
    },
  },
  {
    name: 'get_location_profile',
    description: 'Tiefes Einzel-Ort-Profil (Pendant zu get_figure_profile): Stammdaten (Typ, Beschreibung, Stimmung, erste Erwähnung) + alle Kapitel mit Häufigkeit + `last_chapter` (Arc-Ende) + alle assoziierten Figuren + alle Szenen, die an diesem Ort spielen (mit Titel, Wertung, Kapitel/Abschnitt). Für "erzähl mir alles über den Wald", "welche Szenen spielen im Schloss?", "wer war je am Hafen?". Auswahl per `loc_id` (aus list_locations) oder `name` (exakt oder Substring).',
    input_schema: {
      type: 'object',
      properties: {
        loc_id: { type: 'string', description: 'loc_id des Orts (aus list_locations).' },
        name:   { type: 'string', description: 'Alternative: Ortsname (exakt oder Substring, case-insensitive).' },
      },
      required: [],
    },
  },
  {
    name: 'list_world_facts',
    description: 'Liefert die etablierten Welt-Fakten/Weltregeln des Buchs (deklaratives Buch-Wissen aus der Komplettanalyse): Magiesystem-Regeln, Geografie, Daten, etablierte Aussagen. Pro Fakt: kategorie, subjekt, fakt-Text, betroffene Kapitel; real_widerlegt=true heisst, der Faktencheck hat die Aussage per Quelle als real falsch belegt (Buchaussage, keine reale Tatsache). Beantwortet "welche Weltregeln gelten?", "wie funktioniert die Magie?", "welche Fakten über Ort/Figur X sind etabliert?". Filterbar nach kategorie (exakt) und subjekt (Teilstring).',
    input_schema: {
      type: 'object',
      properties: {
        kategorie: { type: 'string', description: 'Nur Fakten dieser Kategorie. Gültige Werte: figur, ort, objekt, organisation, technik, regel, kultur, historie, zeit, soziolekt, ereignis, sonstiges.' },
        subjekt:   { type: 'string', description: 'Nur Fakten zu diesem Subjekt (Teilstring, case-insensitive).' },
      },
      required: [],
    },
  },
  {
    name: 'list_songs',
    description: 'Listet die Songs/den Soundtrack des Buchs (Musikbibliothek): Titel, Interpret, Genre, Kontext-Typ, Beschreibung, Stimmung, erste Erwähnung + verknüpfte Kapitel (mit Häufigkeit) und Figuren. Beantwortet "welche Musik/Songs gehören zum Buch?", "welcher Song zu Figur X?", "Soundtrack von Kapitel 3?". Filterbar nach chapter_id, figur_id/figur_name.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Songs, die in diesem Kapitel verknüpft sind.' },
        figur_id:   { type: 'string',  description: 'Nur Songs zu dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname der Figur.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_scenes',
    description: 'Listet Szenen aus dem Szenenkatalog (figure_scenes) mit Titel, Wertung, Kommentar, Kapitel/Abschnitt, beteiligten Figuren und Orten. Filterbar nach chapter_id, page_id, figur_id/figur_name (Figur ist in der Szene), loc_id (Ort der Szene). Ideal für "welche Szenen spielt X?", "Szenen in Kapitel 3", "Szenen im Wald".',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Szenen dieses Kapitels.' },
        page_id:    { type: 'integer', description: 'Nur Szenen dieses Abschnitts.' },
        figur_id:   { type: 'string',  description: 'Nur Szenen mit dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname.' },
        loc_id:     { type: 'string',  description: 'Nur Szenen an diesem Ort (loc_id).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_werkstatt_drafts',
    description: 'Listet die Figuren-Werkstatt-Drafts dieses Users (Vorwärts-Entwicklungs-Mindmaps, vom Katalog/get_figure_profile getrennt): Name, Archetyp, Quell-Figur, notes-Vorschau, Brainstorm-/Consistency-Counts, letzter Lauf. Beantwortet "an welchen Figuren arbeitet der User?". Für Details (Mindmap-Text + Run-Inhalte) anschliessend `get_werkstatt_draft` rufen.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_werkstatt_draft',
    description: 'Detail-Output eines Figuren-Werkstatt-Drafts: Mindmap (eingerückter Plaintext in User-Locale) + KI-Läufe (Brainstorm-Vorschläge, Consistency-Konflikte+Fazit) gekürzt. Liefert "was hat der User für Figur X notiert?", "was kam beim Brainstorm raus?". Auswahl per `draft_id` (aus list_werkstatt_drafts) oder `figur_name` (exakt oder Substring, case-insensitive).',
    input_schema: {
      type: 'object',
      properties: {
        draft_id:     { type: 'integer', description: 'Draft-ID aus list_werkstatt_drafts.' },
        figur_name:   { type: 'string',  description: 'Alternative: Name des Werkstatt-Drafts (exakt oder Substring).' },
        include_runs: { type: 'boolean', description: 'true = KI-Läufe mitliefern. Default: true.' },
        run_limit:    { type: 'integer', description: 'Max. Anzahl Läufe (default 5, max 20).' },
      },
      required: [],
    },
  },
  {
    name: 'get_plot_board',
    description: 'Liefert das geplante Beat-Board der Plot-Werkstatt: Akte (Spalten) → Beats (Handlungspunkte) mit Titel, Beschreibung, Status (geplant = Idee / im_buch = eingearbeitet; verworfen ist ein separates Flag), verknüpftem Zielkapitel, Strang (thread, falls Swimlanes angelegt) beteiligten Figuren (Katalog + Werkstatt) sowie — wo gepflegt — Schauplätzen (orte), Motiven (motive), geplanter Spannung (intensitaet 1–5), erzählter Zeit (zeit) und ausgehenden Beat-Kanten (beziehungen: Setup/Payoff bereitet-vor/zahlt-ein, Kausalität fuehrt-zu/motiviert/blockiert/spiegelt). Bei mehreren Hauptfiguren legt der User optional Handlungsstränge (threads, Swimlanes) an — parallele Erzähllinien, oft je Hauptfigur; das Top-Level-Feld threads listet sie (mit gebundener Hauptfigur), und jeder Beat trägt sein thread-Feld (Strang-Name oder null). Das ist die VORWÄRTSGERICHTETE Planung des Users (was er vorhat), getrennt von der rückwärtsgewandten Szenen-/Ereignis-Analyse des geschriebenen Texts. Beantwortet "wie ist die Handlung geplant?", "welche Beats sind noch nicht geschrieben (status=geplant)?", "welcher Beat gehört zu Kapitel X?", "wie entwickelt sich Strang/Hauptfigur Y?", "passt der Plot zum bisherigen Buch?", "wo wird Setup X eingelöst?", "welche Beats spielen an Ort Y?". Pro Buch + User. Leeres Board heisst nur: keine separate Plot-Planung angelegt – nicht, dass das Buch keine Handlung hat. Für den GESCHRIEBENEN Text nutze list_scenes/get_timeline statt dieses Tools.',
    input_schema: {
      type: 'object',
      properties: {
        status:  { type: 'string', enum: ['geplant', 'im_buch'], description: 'Optional: nur Beats mit diesem Status zurückgeben (geplant = Idee, im_buch = eingearbeitet). status_counts zeigt immer die Gesamtverteilung über alle Beats (inkl. verworfen-Zählung).' },
        act_id:  { type: 'integer', description: 'Optional: nur diesen Akt (Spalte) zurückgeben (id aus einem vorherigen Aufruf).' },
      },
      required: [],
    },
  },
  {
    name: 'get_motifs',
    description: 'Liefert die Motiv-Werkstatt-Konstellation dieses Users: Themen (abstrakte Cluster wie "Schuld & Vergebung") → Motive (konkrete wiederkehrende Naben wie Wasser, Spiegel, ein Lied) mit Beschreibung, trigger_terms, Beziehungen (Motiv↔Motiv, z.B. verstärkt/kontrastiert) und dem Soll/Ist-Abgleich pro Motiv. soll = wo das Motiv laut PLAN tragen soll (verknüpfte Figuren/Beats/Kapitel/Abschnitte). ist_count = wie oft die KI-Motiverkennung es REAL im Text fand. geist=true = geplant, aber 0 Fundstellen (fallengelassenes oder noch nicht geschriebenes Motiv). Beantwortet "welche Motive/Themen plant der User?", "welche geplanten Motive fehlen im Text (Geister)?", "wie hängen die Motive zusammen?", "trägt Motiv X laut Plan, wo es soll?". Rein rückwärtsgewandt/planend — nie generativ im Buchtext. Pro Buch + User. Fundstellen-Detail eines Motivs über get_motif_occurrences. Leere Werkstatt heisst nur: keine Motiv-Planung angelegt.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_motif_occurrences',
    description: 'Liefert die realen Fundstellen (Ist) eines Motivs im Text: wo die KI-Motiverkennung es fand — nach Abschnitt (mit Kapitel) oder Szene, mit Textausschnitt (snippet), Score und source (semantic = Embedding-Ähnlichkeit, trigger = wörtlicher trigger_terms-Treffer via FTS). Beantwortet "wo genau taucht das Wasser-Motiv auf?", "in welchen Kapiteln trägt Motiv X?". Auswahl per `motif_id` oder `motif_name` (aus get_motifs; exakt oder Substring, case-insensitive). Keine Fundstellen = Geist-Motiv oder Scan lief noch nicht.',
    input_schema: {
      type: 'object',
      properties: {
        motif_id:   { type: 'integer', description: 'Motiv-ID aus get_motifs.' },
        motif_name: { type: 'string',  description: 'Alternative: Name des Motivs (exakt oder Substring).' },
        limit:      { type: 'integer', description: 'Max. Anzahl Fundstellen (default 40, max 200). Nach Score sortiert.' },
      },
      required: [],
    },
  },
  {
    name: 'find_first_last_mention',
    description: 'Liefert erste + letzte Erwähnung einer Figur (page_figure_mentions) oder eines Orts (location_chapters). Schmaler als `get_figure_mentions` – nur die zwei Endpunkte, ohne Per-Kapitel-Aggregat. Beantwortet "wo erscheint X zuerst?", "wann verschwindet X aus dem Buch?". Pflicht: `figur_id` ∨ `figur_name` ∨ `loc_id`. Ohne Index (Komplettanalyse fehlt): freundlicher Fehler statt 0-Werten.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id der Figur.' },
        figur_name: { type: 'string', description: 'Alternativ: Name/Kurzname der Figur.' },
        loc_id:     { type: 'string', description: 'Alternative: loc_id eines Ortes (aus list_locations).' },
      },
      required: [],
    },
  },
  {
    name: 'get_book_settings',
    description: 'Liefert die Stamm-Einstellungen des Buchs: Sprache, Region, Buchtyp (roman/krimi/lyrik/sachbuch/…), Erzählperspektive (Ich/3.Person personal/auktorial/…), Erzählzeit (Präteritum/Präsens), is_finished-Status, freier buch_kontext-Text (Vorgaben des Users an die KI). Pflichtig vor jeder Stilfrage oder vor jedem Vorschlag, der Sprache/Tonfall/Tempus berührt – sonst kollidiert die Antwort mit den expliziten User-Vorgaben.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_repetitions',
    description: 'Findet N-Gramm-Wiederholungen (häufige Wortgruppen) im Buchtext – ideal für Sprach-Tics, Lieblings-Formulierungen, redundante Phrasen. Standard: n=3 (Tri-Gramme), scope=book, min_count=5, Stopwort-Filter aktiv (sonst dominieren "und der die"). Returns results[{phrase, count, sample_pages:[{page_id,page_name,count}]}]. Nicht nutzen, um eine einzelne bekannte Phrase zu suchen – dafür `search_passages`.',
    input_schema: {
      type: 'object',
      properties: {
        n:                { type: 'integer', description: 'Wortzahl der N-Gramme (2-5). Default: 3.' },
        scope:            { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Default: book.' },
        chapter_id:       { type: 'integer', description: 'Pflicht für scope=chapter.' },
        page_id:          { type: 'integer', description: 'Pflicht für scope=page.' },
        min_count:        { type: 'integer', description: 'Mindesthäufigkeit. Default: 5 (book) bzw. 2.' },
        limit:            { type: 'integer', description: 'Max. Treffer (default 30, max 100).' },
        ignore_stopwords: { type: 'boolean', description: 'true (default): N-Gramme nur aus Funktionswörtern werden ignoriert.' },
      },
      required: [],
    },
  },
  {
    name: 'get_dialogue',
    description: 'Extrahiert Dialog-Passagen (heuristisch via Anführungszeichen «»/„"/""/»«, Speech-Verb+Doppelpunkt, Em-Dash am Zeilenanfang). Mit figur_id/figur_name nur Dialoge, in deren ±100 Zeichen Umfeld der Figurenname vorkommt (Sprecher-Heuristik). Liefert results[{page_id, page_name, offset, length, text, before, after}] – die offsets sind kompatibel mit `quote_passage` und `search_passages`. Ideal für "wie spricht X?", "Dialoge in Kapitel 3", "wo wird viel gesprochen?". Auch der beste Einstieg für inhaltliche Zitat-Selektion nach Eigenschaft (lustigste/schlagfertigste/markanteste Stellen, Humor, Figuren-Stimme): Pointen leben meist im Dialog — gezielter als search_passages (das nur Wortlaut findet) und bei grossen Büchern fokussierter als ganze Kapitel zu laden. Einfache gerade Quotes (\'…\') werden bewusst NICHT erkannt (Apostroph-False-Positives).',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Dialoge dieses Kapitels.' },
        page_id:    { type: 'integer', description: 'Nur Dialoge dieses Abschnitts.' },
        figur_id:   { type: 'string',  description: 'Nur Dialoge im Umfeld dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname.' },
        min_length: { type: 'integer', description: 'Minimale Dialog-Länge in Zeichen (default 4).' },
        limit:      { type: 'integer', description: 'Max. Dialoge (default 30, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'list_revisions',
    description: 'Listet die gespeicherten Revisionen eines Abschnitts (neueste zuerst): rev_id, created_at, source (focus/main/book/chat-apply/lektorat-apply/import/conflict), chars, words, summary. Plus total_revisions. Voraussetzung, um gezielt `diff_page_revisions` zwischen bestimmten Revisionen zu rufen, statt nur den Default-Pfad (zwei jüngste) zu nehmen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        limit:   { type: 'integer', description: 'Maximale Anzahl Revisionen (default 20, max 100).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'diff_page_revisions',
    description: 'Vergleicht zwei Revisionen eines Abschnitts (Plain-Text-Word-Diff). Ohne from_rev_id/to_rev_id: die zwei jüngsten Revisionen. Liefert summary{add,del,change}, chars_delta und blocks[{kind:add/del/change, text|from/to}]. Beantwortet "was hat sich an Abschnitt X seit letztem Edit geändert?", "wie hat sich der Text entwickelt?". Für gezielten Vergleich vorher `list_revisions` rufen, um rev_ids zu holen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:     { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        from_rev_id: { type: 'integer', description: 'Optional: ältere Revision-ID (Default: zweitneueste).' },
        to_rev_id:   { type: 'integer', description: 'Optional: neuere Revision-ID (Default: neueste).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'quote_passage',
    description: 'Liefert ein zeichengenaues Zitat aus einem Abschnitt (offset+length im Plain-Text, kompatibel mit den offsets aus `search_passages` und `get_dialogue`). Liefert page_name, chapter_name, quote (exakte Passage), before/after-Kontext und page_chars. Nutze dies vor JEDEM wörtlichen Zitat in der finalen Antwort – nie aus Erinnerung paraphrasieren oder aus get_pages-Ausschnitten Quotes zusammenkürzen. Wenn du nur Pattern + page_id kennst (kein offset): nimm `quote_match`. Max length: 800 Zeichen; max context_chars: 300.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:       { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        offset:        { type: 'integer', description: 'Start-Offset im Plain-Text (Pflicht, >=0).' },
        length:        { type: 'integer', description: 'Länge in Zeichen (Pflicht, 1-800).' },
        context_chars: { type: 'integer', description: 'Vor-/Nach-Kontext (default 80, max 300, 0 = ohne).' },
      },
      required: ['page_id', 'offset', 'length'],
    },
  },
  {
    name: 'quote_match',
    description: 'Bequemes Pendant zu `quote_passage`: Server sucht den Pattern (case-insensitive Literal-Substring) selbst im Abschnitt und gibt das zeichengenaue Zitat + offset/length zurück. Spart die Sequenz search_passages → quote_passage, wenn du nur ein Pattern und eine page_id hast. Liefert quote, offset, length, before/after, occurrence und total_matches. Bei mehreren Treffern: `occurrence` (1-basiert) wählt den n-ten Treffer; ohne Angabe der erste. Max pattern-Länge: 800. Nicht für Regex – nur Literal. Für Buch-weite Suche ohne bekannte page_id zuerst `search_passages` rufen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:       { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        pattern:       { type: 'string',  description: 'Literaler Substring, der zitiert werden soll (case-insensitive, max 800 Zeichen). Das gefundene Zitat hat die Original-Schreibweise aus dem Abschnittstext.' },
        occurrence:    { type: 'integer', description: 'Wenn das Pattern mehrfach vorkommt: welches Vorkommen (1-basiert)? Default: 1.' },
        context_chars: { type: 'integer', description: 'Vor-/Nach-Kontext (default 80, max 300, 0 = ohne).' },
      },
      required: ['page_id', 'pattern'],
    },
  },
  {
    name: 'generate_image',
    description: 'Erzeugt EIN Bild zu einer textuellen Beschreibung und zeigt es dem User unter deiner Antwort an (im Chat-Verlauf, herunterladbar). Nutze dies nur, wenn der User ausdrücklich ein Bild/eine Illustration/eine Visualisierung wünscht — z.B. ein Figurenporträt, einen Schauplatz, eine Szene oder eine Stimmungs-Illustration zum Buch. Baue den Bild-Prompt selbst aus dem Buchwissen (Aussehen einer Figur, Beschreibung eines Orts/einer Szene) — am besten auf Englisch und mit konkreten visuellen Details (Stil, Licht, Komposition), das liefert bessere Resultate. Das Bild ist reine Visualisierung und wird NICHT in den Buchtext geschrieben. Nach dem Aufruf in final_answer kurz auf das angezeigte Bild verweisen, aber KEINE Bild-URL und keine Markdown-Bildsyntax ausgeben (das Bild rendert das Frontend selbst). Nicht ungefragt aufrufen und nicht für Textfragen verwenden.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Bildbeschreibung für den Generator. Konkret und visuell; bevorzugt Englisch. Pflichtfeld.' },
        size:   { type: 'string', description: 'Optionales Seitenverhältnis/Format als "BREITExHÖHE" (z.B. "1024x1024", "1024x1536"). Ohne Angabe: Server-Default.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die finale Antwort an den User. Rufe dieses Werkzeug als ALLERLETZTEN Aufruf einer Runde — danach folgt keine weitere Iteration und keine weitere Recherche. Pflicht-Endpunkt: jede Antwort an den User MUSS über dieses Werkzeug laufen. Freitext ohne final_answer wird nicht als Antwort akzeptiert. Schreibe die Antwort in der Sprache der Userfrage. Wenn du in der antwort wörtlich zitierst: hänge JEDES Zitat in das Feld `zitate` mit {page_id, offset, length, quote} aus quote_passage/quote_match/search_passages. Der Server validiert post-hoc und zeigt die Zitate als Fussnoten; ungültige werden markiert. Fragen zu realen Ereignissen oder Fakten AUSSERHALB des Manuskripts (Geschichte, Orte, Technik, Personen der Wirklichkeit) kannst du nicht nachprüfen — du hast keine Web-Suche: sag das offen, beantworte nur, was das Buch hergibt, und setze `recherche_hinweis: true` mit einer präzisen `recherche_frage` für den Recherche-Chat.',
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User als Freitext, Markdown erlaubt. Pflichtfeld.' },
        zitate: {
          type: 'array',
          description: 'Optional: alle wörtlichen Zitate, die in der antwort vorkommen, je mit page_id, offset, length und exakt dem zitierten Text. Halluzinationsschutz — der Server prüft, ob text.slice(offset, offset+length) == quote im aktuellen Abschnittstext.',
          items: {
            type: 'object',
            properties: {
              page_id: { type: 'integer', description: 'Abschnitts-ID des Zitats.' },
              offset:  { type: 'integer', description: 'Start-Offset im Plain-Text (>=0).' },
              length:  { type: 'integer', description: 'Länge des Zitats in Zeichen (>0).' },
              quote:   { type: 'string',  description: 'Der exakt zitierte Text (zeichengenau zum Abschnittsinhalt).' },
            },
            required: ['page_id', 'offset', 'length', 'quote'],
          },
        },
        recherche_hinweis: { type: 'boolean', description: 'Optional: true, wenn die Frage (auch) reale Fakten ausserhalb des Manuskripts betrifft, die nur eine Web-Recherche klären kann.' },
        recherche_frage:   { type: 'string',  description: 'Optional (mit recherche_hinweis): die Frage, eigenständig formuliert, wie sie der Recherche-Chat bekommen soll.' },
      },
      required: ['antwort'],
    },
  },
];

// ── Slim-Werkzeugsatz (lokale/kleine Modelle) ─────────────────────────────────
// Der volle Katalog kostet ~10k Input-Tokens PRO Iteration. Bei Claude trägt das
// Prompt-Caching diesen Präfix; ein lokaler Endpunkt hat kein Caching und bezahlt
// ihn jede Runde neu — und ein kleineres Modell trifft aus dem vollen Katalog ohnehin
// schlechter als aus einer kleinen Auswahl. Darum eine kuratierte Teilmenge: Überblick, Suche
// (Wortlaut + Sinn), Volltext, Zitat-Verifikation, die Figuren-Achse, Orte/Szenen,
// Bewertung — plus der Pflicht-Endpunkt.
//
// Bewusst NICHT drin (über den Erst-Kontext oder eigene Karten erreichbar, und für
// die häufigen Fragen entbehrlich): count_pronouns, get_stil_metrics, die Lektorat-,
// Plot-, Motiv-, Ideen-, Song-, Weltfakten-, Werkstatt-, Revisions- und
// Wiederholungs-Werkzeuge, get_dialogue, quote_passage (quote_match deckt den Weg
// ab), find_first_last_mention (steht in get_figure_mentions), get_book_settings.
//
// KEINE zweite Definitionsliste: Namen zeigen auf BOOK_CHAT_TOOLS oben — Drift ist
// durch tests/unit/ai-tool-translate.test.js gegated.
export const BOOK_CHAT_SLIM_TOOL_NAMES = [
  'list_chapters',
  'search_passages',
  'search_similar',
  'get_pages',
  'get_chapter_text',
  'quote_match',
  'list_figures',
  'get_figure_profile',
  'get_figure_mentions',
  'get_figure_relations',
  'get_timeline',
  // Alter/Jahrgang ist die häufigste schmale Faktenfrage — und genau die Rechnung,
  // bei der ein kleines Modell sich verrechnet.
  'get_figure_age',
  'list_scenes',
  'list_locations',
  // Welt-Fakten sind der billigste Weg zu etabliertem Buch-Wissen: schon verdichtete
  // Aussagen statt Passagen, die erst gelesen werden muessen — genau Stufe 2 der
  // Kosten-Leiter. Fehlte das Werkzeug, eskalierte ein kleines Modell fuer «welche
  // Regel gilt hier» auf get_chapter_text.
  'list_world_facts',
  'get_reviews',
  'generate_image',
  'final_answer',
];

// Regel für Fragen zur Aussenwelt — wird im Job (routes/jobs/chat/book-chat.js#prepare)
// an den stabilen System-Block 1 gehängt. Der Buch-Chat hat KEINE Web-Suche; ohne
// diese Regel beantwortet das Modell reale Fakten aus seinem Trainingswissen, und die
// Antwort sieht im Buch-Chat aus wie ein Befund aus dem Manuskript.
export const BOOK_CHAT_OUTSIDE_WORLD_RULE = [
  'AUSSENWELT: Du hast KEINE Web-Suche und kein Wissen ausser dem Manuskript und den Index-Werkzeugen.',
  'Betrifft eine Frage reale Ereignisse, Orte, Personen oder Fakten ausserhalb des Buchs (z.B. «stimmt das historisch?», «wann fiel die Mauer wirklich?»), sag klar, dass der Buch-Chat das nicht prüfen kann, und verweise auf den Recherche-Chat.',
  'Setze dann in `final_answer` `recherche_hinweis: true` und `recherche_frage` (eigenständig formuliert, ohne Bezug auf diesen Chat). Was das Manuskript selbst dazu sagt, beantwortest du trotzdem.',
  'Ausnahme: was der Autor selbst recherchiert hat, steht im Recherche-Board (list_research_items/read_research_item). Das darfst du heranziehen — kennzeichne es als gesammeltes Material des Autors, nicht als geprüfte Tatsache und nicht als Buchstelle.',
].join('\n');

// Synthese-Aufforderung, wenn der Kosten-Deckel pro Antwort
// (`jobs.book_chat.max_input_tokens_per_answer`) erreicht ist — Gegenstück zu
// BOOK_CHAT_FORCE_FINAL_INSTRUCTION (Iterationsdeckel), gleicher Ablauf.
export const BOOK_CHAT_BUDGET_FINAL_INSTRUCTION =
  'Das Recherche-Budget für diese Antwort ist aufgebraucht — keine weitere Recherche mehr möglich. '
  + 'Fasse JETZT aus den bereits gesammelten Informationen die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Wenn die Recherche unvollständig blieb, beantworte die Frage so weit wie möglich und nenne kurz, was offen blieb. '
  + 'Sprache der Antwort: die der Userfrage.';

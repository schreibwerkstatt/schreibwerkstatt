// Chat-Werkzeuge: Material und Planung des Autors — Plot-Board, Motive,
// Figuren-Werkstatt, Ideen, Recherche-Archiv, Literatur-Register, Bild.
// Format und Regeln: ./CLAUDE.md (gilt für jeden Eintrag).

export const PLANNING_TOOLS = [
  {
    name: 'get_plot_board',
    description: 'Beat-Board der Plot-Werkstatt — die VORWÄRTSGERICHTETE Planung des Autors, getrennt vom geschriebenen Text: Akte → Beats mit Titel, Beschreibung, Status (geplant = Idee, im_buch = eingearbeitet; verworfen ist ein eigenes Flag), Zielkapitel, Strang, Figuren und wo gepflegt Orte, Motive, Spannung (intensitaet 1–5), erzählte Zeit und Beat-Kanten (Setup/Payoff bereitet-vor/zahlt-ein, Kausalität fuehrt-zu/motiviert/blockiert/spiegelt). `threads` listet die Handlungsstränge (Swimlanes, oft je Hauptfigur). Ein leeres Board heisst nur: keine Planung angelegt.',
    see: {
      list_scenes: 'Den GESCHRIEBENEN Text erschliesst `list_scenes`.',
      get_timeline: 'Die erzählte Chronologie liefert `get_timeline`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['geplant', 'im_buch'], description: 'Optional: nur Beats mit diesem Status. status_counts zeigt immer die Gesamtverteilung (inkl. verworfen).' },
        act_id: { type: 'integer', description: 'Optional: nur diesen Akt (id aus einem vorherigen Aufruf).' },
      },
      required: [],
    },
  },
  {
    name: 'get_motifs',
    description: 'Motiv-Werkstatt des Autors: Themen (Cluster wie «Schuld & Vergebung») → Motive (wiederkehrende Naben wie Wasser, Spiegel, ein Lied) mit Beschreibung, trigger_terms, Motiv-Beziehungen und Soll/Ist-Abgleich — soll = wo das Motiv laut Plan trägt, ist_count = Fundstellen der Motiverkennung im Text, geist=true = geplant, aber ohne Fundstelle. Mit motif_id oder motif_name stattdessen die realen Fundstellen DIESES Motivs (Abschnitt oder Szene, snippet, score, source semantic|trigger). Leere Werkstatt heisst nur: keine Motiv-Planung angelegt.',
    input_schema: {
      type: 'object',
      properties: {
        motif_id:   { type: 'integer', description: 'Optional: Fundstellen dieses Motivs (id aus der Übersicht).' },
        motif_name: { type: 'string',  description: 'Alternative: Name des Motivs (exakt oder Teilstring).' },
        limit:      { type: 'integer', description: 'Nur mit Motiv: max. Fundstellen (default 40, max 200), nach Score sortiert.' },
      },
      required: [],
    },
  },
  {
    name: 'list_werkstatt_drafts',
    description: 'Figuren-Werkstatt des Autors (Vorwärts-Entwicklung, getrennt vom Figurenkatalog). Ohne Auswahl: die Entwürfe mit draft_id, Name, Archetyp, Quell-Figur, Notiz-Vorschau, Anzahl Brainstorm-/Konsistenz-Läufe und letztem Lauf. Mit draft_id oder figur_name: das Detail EINES Entwurfs — Mindmap als eingerückter Text und die KI-Läufe (Brainstorm-Vorschläge, Konsistenz-Konflikte samt Fazit). Für «an welchen Figuren arbeite ich?», «was habe ich zu Figur X notiert?».',
    input_schema: {
      type: 'object',
      properties: {
        draft_id:     { type: 'integer', description: 'Optional: Detail dieses Entwurfs (draft_id aus der Liste).' },
        figur_name:   { type: 'string',  description: 'Alternative: Name des Entwurfs (exakt oder Teilstring).' },
        include_runs: { type: 'boolean', description: 'Nur Detail: KI-Läufe mitliefern (Default true).' },
        run_limit:    { type: 'integer', description: 'Nur Detail: max. Anzahl Läufe (default 5, max 20).' },
      },
      required: [],
    },
  },
  {
    name: 'list_ideen',
    description: 'Ideen und Pendenzen des Autors mit Kapitel-/Abschnittskontext. scope: "page" (Abschnitt), "chapter" oder "book" (noch ohne Ort); status: offen → in_arbeit → erledigt, daneben verworfen — VERWORFEN heisst geprüft und abgelehnt: nicht erneut vorschlagen. Offene zuerst. `verknuepft` nennt, woran eine Idee planerisch hängt (art beat/motif/research/…, mit id und label). Für «was wollte ich an Kapitel X noch ändern?», «welche Pendenzen hängen an Beat Y?». Der Kapitel-Filter umfasst Ideen am Kapitel und an seinen Abschnitten.',
    input_schema: {
      type: 'object',
      properties: {
        status:     { type: 'string', enum: ['offen', 'in_arbeit', 'erledigt', 'verworfen'], description: 'Nur Ideen dieser Stufe.' },
        offen_only: { type: 'boolean', description: 'true = nur noch offene (offen ODER in_arbeit).' },
        page_id:    { type: 'integer', description: 'Nur Ideen zu diesem Abschnitt.' },
        chapter_id: { type: 'integer', description: 'Nur Ideen zu diesem Kapitel (am Kapitel + an seinen Abschnitten).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_research_items',
    description: 'Recherche-Archiv des Buchs: vom Autor gesammelte Notizen, Links, Zitate, Fakten, Bilder, PDFs und Interviews — id, kind, status, Titel, Kurztext, Tags, ob ein Dokument angehängt ist; `stellen` = verknüpfte Kapitel/Abschnitte, `bezug` = Figuren/Orte/Szenen. status: offen → in_arbeit → eingearbeitet, daneben verworfen (geprüft, bewusst nicht verwendet). Für «was habe ich zu X gesammelt?», «was ist noch nicht eingearbeitet?». Material des Autors, KEIN Manuskripttext — nie als Buchstelle zitieren.',
    see: {
      read_research_item: 'Volltext eines Eintrags → `read_research_item`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        q:          { type: 'string', description: 'Optionale Volltextsuche (Wortlaut).' },
        kind:       { type: 'string', enum: ['note', 'link', 'quote', 'fact', 'image', 'document', 'transcript'], description: 'Optionaler Typfilter.' },
        status:     { type: 'string', enum: ['offen', 'in_arbeit', 'eingearbeitet', 'verworfen'], description: 'Nur Einträge dieser Stufe.' },
        chapter_id: { type: 'integer', description: 'Nur Einträge an diesem Kapitel oder einem seiner Abschnitte.' },
        page_id:    { type: 'integer', description: 'Nur Einträge an diesem Abschnitt.' },
      },
      required: [],
    },
  },
  {
    name: 'read_research_item',
    description: 'Volltext EINES Recherche-Eintrags: Titel, Inhalt, URLs, Quelle, Tags, Status, Verknüpfungen und bei angehängtem PDF der Dokumenttext (die ersten 8000 Zeichen — doc_chars und doc_truncated weisen die Kappung aus). Lies vorhandenes Material, bevor du dich darauf stützt oder etwas neu recherchierst.',
    see: {
      search_research_passages: 'Stellen weiter hinten in einem langen PDF → `search_research_passages` mit item_id.',
    },
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id des Recherche-Eintrags.' } },
      required: ['id'],
    },
  },
  {
    name: 'search_research_passages',
    description: 'Semantische Passagen-Suche im Recherche-Archiv (Embeddings): Stellen, die einer Frage BEDEUTUNGSMÄSSIG nahestehen, auch bei anderer Wortwahl. Ohne item_id: die beste Passage je Eintrag über das ganze Archiv. Mit item_id: mehrere passende Passagen INNERHALB eines Eintrags — der Weg in ein langes PDF. Liefert {item_id, title, passage, score}.',
    see: {
      list_research_items: 'Wortsuche im Archiv → `list_research_items` mit q.',
    },
    input_schema: {
      type: 'object',
      properties: {
        q:       { type: 'string',  description: 'Suchtext oder Frage in natürlicher Sprache.' },
        item_id: { type: 'integer', description: 'Optional: nur in diesem Eintrag suchen.' },
        top_k:   { type: 'integer', description: 'Anzahl Passagen (1–15, Default 6).' },
      },
      required: ['q'],
    },
  },
  {
    name: 'lookup_literature',
    description: 'Sucht in bibliografischen Registern statt im offenen Web: Crossref (Fachaufsätze, Berichte, alles mit DOI) und OpenLibrary (Bücher). Zitierfähige Kerndaten je Treffer — Titel, Autoren, Jahr, Zeitschrift/Verlag, DOI bzw. ISBN und eine stabile URL (doi.org). Für Fachliteratur, Studien oder Bücher zu einem Thema und um eine bekannte DOI/ISBN aufzulösen. Kein Volltext und keine Studiendetails (Design, Fallzahl) — die stehen nur im Werk selbst.',
    input_schema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Thema oder Titel-/Autorenstichworte (für Fachdatenbanken englische Begriffe bevorzugen).' },
        doi:      { type: 'string', description: 'Alternativ: eine bekannte DOI exakt auflösen.' },
        isbn:     { type: 'string', description: 'Alternativ: eine bekannte ISBN exakt auflösen.' },
        register: { type: 'string', enum: ['artikel', 'buch', 'beide'], description: 'artikel = nur Crossref, buch = nur OpenLibrary, beide (Default).' },
        anzahl:   { type: 'integer', description: 'Treffer je Register (1–10, Default 5).' },
      },
      required: [],
    },
  },
  {
    name: 'list_book_entities',
    description: 'Kompakte Übersicht der erzählten Welt in einem Aufruf: Figuren, Schauplätze, Szenen, Plot-Beats und Handlungsstränge, je mit id, Name und Kurzbeschreibung. Für Recherche FÜR die Geschichte (Beruf einer Figur, Land eines Schauplatzes), nicht für Detailfragen zum Text.',
    input_schema: {
      type: 'object',
      properties: {
        art: { type: 'string', enum: ['figur', 'ort', 'szene', 'beat', 'strang', 'alle'], description: "Welche Kategorie. Default 'alle'." },
      },
      required: [],
    },
  },
  {
    name: 'generate_image',
    description: 'Erzeugt EIN Bild zu einer Beschreibung und zeigt es dem User unter deiner Antwort (im Verlauf, herunterladbar) — nur, wenn er ausdrücklich ein Bild wünscht (Figurenporträt, Schauplatz, Szene, Stimmung). Den Bild-Prompt baust du selbst aus dem Buchwissen, am besten auf Englisch mit konkreten visuellen Details (Stil, Licht, Komposition). Das Bild landet NICHT im Buchtext. In der Antwort kurz darauf verweisen, aber keine Bild-URL und keine Markdown-Bildsyntax.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Bildbeschreibung für den Generator: konkret, visuell, bevorzugt Englisch. Pflicht.' },
        size:   { type: 'string', description: 'Optional: Format als "BREITExHÖHE" (z.B. "1024x1024", "1024x1536"). Ohne Angabe: Server-Default.' },
      },
      required: ['prompt'],
    },
  },
];

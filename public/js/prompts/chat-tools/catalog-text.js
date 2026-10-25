// Chat-Werkzeuge: Text — Gliederung, Suche (Wortlaut + Sinn), Volltext, Zitat,
// Dialog, Wiederholungen. Format und Regeln: ./CLAUDE.md (gilt für jeden Eintrag).

export const TEXT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Gliederung des Buchs in Lesereihenfolge: Summen (total_chapters/total_pages/total_words), `hint` und `chapters` mit chapter_id, Name, depth (1 = Kapitel, 2 = Unterkapitel, 3 = Unter-Unterkapitel), parent_chapter_id, words/words_total und `pages` als Tupel [page_id, page_name, words] (siehe page_format). continued=true = Abschnitte desselben Kapitels nach seinen Unterkapiteln; chapter_id=null = Abschnitte ohne Kapitel an dieser Stelle. Die Reihenfolge IST die Lesereihenfolge («was kommt vor/nach X?»). Steht next_offset im Ergebnis, mit offset weiterblättern.',
    see: {
      get_stil_metrics: 'Detailstatistik eines Kapitels (Dialoganteil, häufigste Figuren) → `get_stil_metrics`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', description: 'Optional: erster Eintrag (0-basiert, default 0). Aus next_offset übernehmen.' },
        limit:  { type: 'integer', description: 'Optional: max. Anzahl Einträge (default alle, die in die Antwort passen).' },
      },
      required: [],
    },
  },
  {
    name: 'search_passages',
    description: 'Volltextsuche nach WORTLAUT (FTS5, bm25-sortiert): exakte Treffer mit offset/length und Snippet. Literal ist eine Phrasensuche — mehrere Wörter werden als genaue Wortfolge gesucht, nicht als ODER; Alternativen nur mit regex=true (JavaScript-Regex, scannt alle Abschnitte). Für «wo kommt das Wort / der Name / die Phrase X vor?». Ungeeignet für Stellen nach einer Eigenschaft, die nicht im Wortlaut steht (Stimmung, Stilmittel, Motiv) — dafür keine Stichwörter raten.',
    see: {
      search_similar: 'Stellen nach Sinn oder Eigenschaft → `search_similar`.',
      get_chapter_text: 'Auswahl oder Vollständigkeit über den ganzen Text (lustigste Stelle, ALLE Stellen zu X) → Kapitel lesen mit `get_chapter_text`.',
      get_figure_mentions: 'Auftritte einer Figur → `get_figure_mentions`.',
      quote_passage: 'Treffer-Offsets passen direkt in `quote_passage`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Ein Wort, ein Name oder eine feste Phrase (Literal); mit regex=true ein Muster, z.B. «lustig|komisch|witzig».' },
        regex:       { type: 'boolean', description: 'true = pattern als JavaScript-Regex, ohne FTS5-Vorfilter. Default: false.' },
        chapter_id:  { type: 'integer', description: 'Optional: nur in diesem Kapitel suchen (inkl. Unterkapitel).' },
        page_id:     { type: 'integer', description: 'Optional: nur in diesem Abschnitt suchen (hat Vorrang vor chapter_id).' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_similar',
    description: 'Semantische Suche (Embeddings) über das ganze Buch: Passagen, Szenen, Figuren, Orte und Welt-Fakten, die einem Suchtext BEDEUTUNGSMÄSSIG nahestehen — auch mit anderen Wörtern. Erste Wahl für Stellen nach Eigenschaft oder Sinn («dieselbe resignierte Stimmung», «Szenen wie ein Abschied am Bahnhof»). Treffer {kind, entity_id, title, snippet, rank, similarity}, Abschnitts-Treffer zusätzlich chapter_name und offset/length. Der Ausschnitt ist um den passendsten Satz zentriert und oft schon die Antwort. index_incomplete=true: der Index deckt das Buch nur teilweise ab — fehlende Treffer beweisen dann nichts.',
    see: {
      search_passages: 'Konkrete Wörter oder Namen → `search_passages`.',
      get_chapter_text: 'Superlative oder Vollständigkeit über den ganzen Text → Kapitel lesen mit `get_chapter_text`.',
      quote_passage: 'offset/length passen in `quote_passage`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        query:   { type: 'string',  description: 'Freitext, dessen Bedeutung gesucht wird: eine Beschreibung, ein Beispielsatz, ein Motiv.' },
        kinds:   { type: 'array', items: { type: 'string', enum: ['page', 'scene', 'figure', 'location', 'fact', 'research'] }, description: 'Optional: Treffertypen einschränken. research = Recherche-Material des Autors, nur auf ausdrücklichen Wunsch. Default: alle ausser research.' },
        limit:   { type: 'integer', description: 'Maximale Trefferzahl (default 20, max 50). Bei grossem snippet_chars kleiner wählen (6–10), sonst kürzt der Server die Liste.' },
        snippet_chars: { type: 'integer', description: 'Ausschnittlänge pro Treffer (default 700, max 1500). Für Suchen nach Eigenschaft/Stimmung 1200–1500 — der Ausschnitt ersetzt dann das Nachladen des Volltexts.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_pages',
    description: 'Volltext bestimmter Abschnitte (bis 20 pro Aufruf) mit chapter_name und bei Unterkapiteln chapter_path. Liegt ein gespeichertes Lektorat vor, kommt latest_check {checked_at, error_count, fazit, stilanalyse} mit. Teuer: für Zitate, Detail-Analyse und Lektüre, nicht für Trefferlisten. Lange Abschnitte kommen in Fenstern: page_chars nennt die Länge; truncated=true mit next_offset heisst, mit offset=next_offset (gleiche ids) weiterlesen, bis kein next_offset mehr kommt.',
    see: {
      get_chapter_text: 'Ein ganzes Kapitel → `get_chapter_text`.',
      search_passages: 'Fundstellen eines Worts → `search_passages`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        ids:                { type: 'array', items: { type: 'integer' }, description: 'page_ids aus der Gliederung oder einem Werkzeug-Ergebnis.' },
        max_chars_per_page: { type: 'integer', description: 'Fenstergrösse pro Abschnitt in Zeichen. Der Server klemmt ans Kontextfenster – nur setzen, wenn weniger gewünscht.' },
        offset:             { type: 'integer', description: 'Zeichen-Offset, ab dem gelesen wird (Default 0), für jeden angefragten Abschnitt. Zum Weiterblättern next_offset übergeben, am besten mit einer einzelnen id.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_chapter_text',
    description: 'Volltext aller Abschnitte eines Kapitels in Lesereihenfolge, standardmässig inklusive Unterkapitel (max 20 Abschnitte): total_pages, bei Unterkapiteln subchapters[] und pages[{page_id, page_name, chapter_id?, chapter_name?, text, page_chars, truncated, next_offset?}]. Für «fasse Kapitel X zusammen», «wie endet Kapitel 3?». Gekürzte Abschnitte (truncated=true) mit offset=next_offset weiterlesen — für das Ende eines Kapitels nicht beim Anfang stehen bleiben. Hat das Kapitel mehr als 20 Abschnitte, nennt `dropped` den Rest.',
    see: {
      get_pages: 'Den Rest (dropped) gezielt mit `get_pages` nachladen.',
    },
    input_schema: {
      type: 'object',
      properties: {
        chapter_id:          { type: 'integer', description: 'Kapitel-ID aus der Gliederung (Pflicht).' },
        include_subchapters: { type: 'boolean', description: 'Abschnitte der Unterkapitel mitladen (Default true). false = nur die direkt im Kapitel stehenden.' },
        max_pages:           { type: 'integer', description: 'Anzahl Abschnitte max. (1-20, Default: alle bis 20).' },
        max_chars_per_page:  { type: 'integer', description: 'Fenstergrösse pro Abschnitt in Zeichen. Der Server klemmt ans Kontextfenster.' },
        offset:              { type: 'integer', description: 'Zeichen-Offset, ab dem gelesen wird (Default 0), für jeden Abschnitt des Kapitels. Zum Weiterblättern next_offset übergeben.' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'quote_passage',
    description: 'Zeichengenaues Zitat aus EINEM Abschnitt — Pflicht vor jedem wörtlichen Zitat in der Antwort; nie aus dem Gedächtnis oder aus gekürzten Ausschnitten zitieren. Zwei Wege: offset+length (aus Such- oder Dialog-Treffern) ODER pattern — dann sucht der Server den Text selbst (Literal, Gross-/Kleinschreibung egal; occurrence wählt den n-ten Treffer). Liefert quote, offset, length, page_name, chapter_name, before/after und page_chars, beim pattern-Weg zusätzlich occurrence und total_matches. Höchstens 800 Zeichen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:       { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        offset:        { type: 'integer', description: 'Weg 1: Start-Offset im Plain-Text (>= 0), zusammen mit length.' },
        length:        { type: 'integer', description: 'Weg 1: Länge in Zeichen (1-800).' },
        pattern:       { type: 'string',  description: 'Weg 2 statt offset/length: der wörtliche Text, der zitiert werden soll (max 800 Zeichen). Das Zitat kommt in der Original-Schreibweise zurück.' },
        occurrence:    { type: 'integer', description: 'Weg 2: welches Vorkommen bei mehreren Treffern (1-basiert, Default 1).' },
        context_chars: { type: 'integer', description: 'Vor-/Nach-Kontext (default 80, max 300, 0 = ohne).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'get_dialogue',
    description: 'Dialog-Passagen, heuristisch erkannt: Anführungszeichen «»/„"/»«, Sprechverb + Doppelpunkt, Gedankenstrich am Zeilenanfang und jede Nachricht eines SMS-/Chat-Verlaufs (einfache gerade Quotes nicht — Apostroph-Fehltreffer). Mit Figur: nur Dialoge, in deren ±100-Zeichen-Umfeld ihr Name steht. Liefert results[{page_id, page_name, offset, length, text, before, after}]. Für «wie spricht X?» und der beste Einstieg für Zitat-Auswahl nach Eigenschaft (lustigste, schlagfertigste Stellen) — Pointen leben meist im Dialog.',
    see: {
      quote_passage: 'Die Offsets passen in `quote_passage`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Dialoge dieses Kapitels (inkl. Unterkapitel).' },
        page_id:    { type: 'integer', description: 'Nur Dialoge dieses Abschnitts.' },
        figur_id:   { type: 'string',  description: 'Nur Dialoge im Umfeld dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname der Figur.' },
        min_length: { type: 'integer', description: 'Minimale Dialog-Länge in Zeichen (default 4).' },
        limit:      { type: 'integer', description: 'Max. Dialoge (default 30, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'find_repetitions',
    description: 'N-Gramm-Wiederholungen (häufige Wortgruppen) im Text — Sprach-Tics, Lieblingsformulierungen, redundante Phrasen. Default n=3, scope=book, min_count=5, Stopwort-Filter aktiv (sonst dominieren «und der die»). Liefert results[{phrase, count, sample_pages:[{page_id, page_name, count}]}].',
    see: {
      search_passages: 'Eine bekannte Phrase suchen → `search_passages`.',
      list_redundancies: 'Inhaltlich doppelt Erzähltes → `list_redundancies`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        n:                { type: 'integer', description: 'Wortzahl der N-Gramme (2-5). Default: 3.' },
        scope:            { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Default: book.' },
        chapter_id:       { type: 'integer', description: 'Pflicht für scope=chapter (inkl. Unterkapitel).' },
        page_id:          { type: 'integer', description: 'Pflicht für scope=page.' },
        min_count:        { type: 'integer', description: 'Mindesthäufigkeit. Default: 5 (book) bzw. 2.' },
        limit:            { type: 'integer', description: 'Max. Treffer (default 30, max 100).' },
        ignore_stopwords: { type: 'boolean', description: 'true (Default): N-Gramme nur aus Funktionswörtern werden ignoriert.' },
      },
      required: [],
    },
  },
];

// Chat-Werkzeuge: gespeicherte Befunde und Messungen — Bewertungen, Lektorat,
// Stil-Metriken, Bearbeitungsstand, Redundanz-Radar, Revisionen, Einstellungen,
// frühere Gespräche. Format und Regeln: ./CLAUDE.md (gilt für jeden Eintrag).

const PRONOUNS = ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'];

export const ANALYSIS_TOOLS = [
  {
    name: 'get_reviews',
    description: 'Gespeicherte Bewertungen dieses Buchs, ohne weiteren KI-Aufruf. scope="book": letzte Buchbewertung (gesamtnote 1.0–6.0, Stärken, Schwächen, Fazit, Zusammenfassung). scope="chapter" (Default): Kapitelbewertungen mit denselben Feldern plus ohne_bewertung[] für noch nicht bewertete Kapitel. Für «wie gut ist das Buch?» bzw. «welche Kapitel sind am stärksten/schwächsten?».',
    input_schema: {
      type: 'object',
      properties: {
        scope:       { type: 'string', enum: ['book', 'chapter'], description: 'Default: chapter.' },
        chapter_ids: { type: 'array', items: { type: 'integer' }, description: 'Nur für scope=chapter: auf diese Kapitel-IDs filtern. Ohne Angabe: alle bewerteten Kapitel.' },
        sort:        { type: 'string', enum: ['note_desc', 'note_asc', 'chapter'], description: 'Nur für scope=chapter. Default: note_desc (stärkste zuerst).' },
        limit:       { type: 'integer', description: 'Nur für scope=chapter. Default 30, max 100.' },
      },
      required: [],
    },
  },
  {
    name: 'get_lektorat',
    description: 'Gespeicherte Lektorat-Ergebnisse (letzter Check pro Abschnitt). view="hotspots" (Default): pro Kapitel total/avg/max Fehler plus die Abschnitte mit den meisten Fehlern samt fazit-Auszug — «wo sind die schwersten Probleme?». view="findings": Einzelbefunde findings[{page_id, page_name, chapter_name, checked_at, typ, original, korrektur, erklaerung, offset?, length?}] mit by_typ und total_findings — «zeig mir die Stilfehler in Kapitel 3». Erst Überblick, dann Detail. Zählt Befunde, misst keine Satzstruktur.',
    see: {
      get_stil_metrics: 'Passiv-Anteil, LIX, Dialoganteil → `get_stil_metrics`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        view:       { type: 'string', enum: ['hotspots', 'findings'], description: 'hotspots = Überblick (Default), findings = Einzelbefunde.' },
        chapter_id: { type: 'integer', description: 'Nur dieses Kapitel.' },
        page_id:    { type: 'integer', description: 'Nur view=findings: nur dieser Abschnitt (hat Vorrang vor chapter_id).' },
        typ:        { type: 'string',  description: 'Nur view=findings: Fehlertyp, z.B. "stil", "grammatik", "rechtschreibung", "interpunktion", "fluss", "wortwahl".' },
        min_errors: { type: 'integer', description: 'Nur view=hotspots: Mindest-Fehleranzahl pro Abschnitt (default 0).' },
        limit:      { type: 'integer', description: 'hotspots: Anzahl Top-Abschnitte (default 20); findings: Befunde (default 30). Max 100.' },
      },
      required: [],
    },
  },
  {
    name: 'get_stil_metrics',
    description: 'Stil- und Lesbarkeitsmetriken: words, chars, sentences, dialog_chars, dialog_ratio_percent, filler_count, passive_count, adverb_count, avg_sentence_len, sentence_len_p90, lix, flesch_de. scope="book" = Buch-Aggregat, "chapter" = pro Kapitel (include_figures hängt die Top-5-Figuren an), "page" = Top-Abschnitte nach einer Metrik. Mit `pronouns` zusätzlich Pronomen-Zählung, getrennt nach Erzähltext und Dialog — für Fragen zur Erzählperspektive. Für «wie viel Passiv?», «welche Kapitel haben am meisten Dialog?», «wer ist in Kapitel X am häufigsten?».',
    see: {
      get_lektorat: 'Fehleranzahl und Lektorat-Befunde → `get_lektorat`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        scope:           { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Aggregations-Scope. Default: book.' },
        chapter_id:      { type: 'integer', description: 'Nur für scope=chapter: einzelnes Kapitel statt aller.' },
        include_figures: { type: 'boolean', description: 'Nur für scope=chapter: pro Kapitel `top_figuren` (max 5) anhängen.' },
        metric:          { type: 'string', enum: ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'], description: 'Nur für scope=page: Sortier-Metrik. Default: passive_count.' },
        order:           { type: 'string', enum: ['asc', 'desc'], description: 'Nur für scope=page. Default: desc (höchster Wert zuerst).' },
        limit:           { type: 'integer', description: 'Nur für scope=page: Anzahl Abschnitte (default 10, max 50).' },
        pronouns:        { type: 'array', items: { type: 'string', enum: [...PRONOUNS, 'alle'] }, description: 'Optional: Pronomen-Gruppen zählen ("alle" = jede Gruppe). scope=chapter zählt pro Kapitel, sonst fürs ganze Buch.' },
      },
      required: [],
    },
  },
  {
    name: 'get_edit_status',
    description: 'Bearbeitungsstand, den der AUTOR selbst pro Abschnitt gesetzt hat: eine geordnete Kette (`chain`, z.B. rohfassung → ueberarbeitet → redigiert → final), letzte Stufe = fertig (`done_stage`). Liefert `counts` je Stufe (+ `ohne` = nie markiert, `stale` = seit dem Setzen geändert), `chapters` mit dem Kapitelstand (= schwächste Stufe darunter, null sobald ein Abschnitt keine Stufe hat) und `pages` als Tupel (siehe page_format). Für «wie weit bin ich?», «was ist noch Rohfassung?», «woran als Nächstes?». Selbsteinschätzung, KEIN Qualitätsurteil.',
    see: {
      get_reviews: 'Qualitätsurteil → `get_reviews`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        status:     { type: 'string',  description: 'Optional: nur Abschnitte auf dieser Stufe (Name aus `chain`) oder "ohne".' },
        not_done:   { type: 'boolean', description: 'Optional: nur Abschnitte, die noch nicht auf der letzten Stufe stehen.' },
        stale_only: { type: 'boolean', description: 'Optional: nur Abschnitte, deren Text nach dem Setzen der Stufe geändert wurde.' },
        chapter_id: { type: 'integer', description: 'Optional: nur Abschnitte dieses Kapitels (inkl. Unterkapitel).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl Abschnitte in `pages` (default 300).' },
      },
      required: [],
    },
  },
  {
    name: 'list_redundancies',
    description: 'Letzter Lauf des Redundanz-Radars (nichts wird neu berechnet): `page_pairs` = Passagen zweier Abschnitte, die sich inhaltlich stark ähneln (doppelt erzählte Szenen, wiederholte Erklärungen), mit score, Abschnitt, Kapitelpfad und Passagentext; `figure_pairs` = Figuren mit fast deckungsgleichem Profil (art "duplicate" = Namen überlappen, "alias" = verschiedene Namen). Vom Autor ignorierte Paare fehlen; changed_since_run = Abschnitt seither bearbeitet. Ein Paar ist ein Hinweis, kein Beweis.',
    see: {
      quote_passage: 'Vor einer Aussage die Stelle mit `quote_passage` prüfen.',
      find_repetitions: 'Wörtliche Phrasen-Wiederholungen → `find_repetitions`.',
    },
    input_schema: {
      type: 'object',
      properties: {
        kind:       { type: 'string', enum: ['all', 'page', 'figure'], description: 'Nur Passagen- oder nur Figuren-Paare (default all).' },
        chapter_id: { type: 'integer', description: 'Optional: nur Passagen-Paare mit mindestens einem Abschnitt in diesem Kapitel (inkl. Unterkapitel); Figuren-Paare entfallen dann.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl Paare je Art (default 20, max 60).' },
        text_chars: { type: 'integer', description: 'Zeichen Passagentext je Seite eines Paars (default 300, max 1500).' },
      },
      required: [],
    },
  },
  {
    name: 'list_revisions',
    description: 'Gespeicherte Revisionen eines Abschnitts. Ohne diff: Liste (neueste zuerst) mit rev_id, created_at, source (focus/main/book/chat-apply/lektorat-apply/import/conflict/macapp/split — split = Abschnitt geteilt), chars, words, summary und total_revisions. Mit diff=true: Wort-Diff zweier Revisionen — Default die zwei jüngsten, gezielt über from_rev_id/to_rev_id — mit summary{add, del, change}, chars_delta und blocks[{kind, text | from/to}]. Für «was hat sich an Abschnitt X geändert?», «wie hat sich der Text entwickelt?».',
    input_schema: {
      type: 'object',
      properties: {
        page_id:     { type: 'integer', description: 'Abschnitts-ID (Pflicht).' },
        diff:        { type: 'boolean', description: 'true = zwei Revisionen vergleichen statt auflisten.' },
        from_rev_id: { type: 'integer', description: 'Nur mit diff: ältere Revision (Default: zweitneueste).' },
        to_rev_id:   { type: 'integer', description: 'Nur mit diff: neuere Revision (Default: neueste).' },
        limit:       { type: 'integer', description: 'Nur Liste: maximale Anzahl (default 20, max 100).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'get_book_settings',
    description: 'Stamm-Einstellungen des Buchs: Sprache, Region, Buchtyp, Erzählperspektive, Erzählzeit, Fertig-Status, Tagesziel und der freie Kontext-Text des Autors (Vorgaben an die KI). Buchtyp, Perspektive, Tempus und Autorenvorgaben stehen schon im System-Prompt — nur aufrufen, wenn du die übrigen Angaben brauchst.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_chat_history',
    description: 'Durchsucht FRÜHERE Gespräche des Autors zu diesem Buch (Buch- und Abschnitts-Chats, nicht das laufende) nach Wortlaut und Bedeutung — wenn er sich auf Besprochenes bezieht («wie hatten wir das entschieden?», «was hast du letzte Woche zu Kapitel 3 gesagt?»). Treffer {session_id, kind (book|page), page_name, title, created_at, snippet}. Ein `hint` meldet eine ausgefallene Bedeutungssuche oder fehlende Runden — die Liste ist dann unvollständig. Frühere Antworten können veraltet sein: gegen den aktuellen Text prüfen und als Stand des früheren Gesprächs kennzeichnen.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string',  description: 'Wonach gesucht wird — Stichwort, Name oder Umschreibung des Themas.' },
        scope: { type: 'string',  enum: ['all', 'book', 'page'], description: 'Optional: nur Buch-Chats (book), nur Abschnitts-Chats (page) oder beide (all, Default).' },
        limit: { type: 'integer', description: 'Maximale Trefferzahl (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
];

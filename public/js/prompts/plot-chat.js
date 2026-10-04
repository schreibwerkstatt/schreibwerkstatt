// Plot-Chat (Panel in der Plot-Werkstatt). Entwickelt das Beat-Board im
// Gespräch und schlägt Änderungen am Board vor (propose_beat / propose_beat_move /
// propose_act / propose_thread). Ein Vorschlag schreibt NICHTS — der User
// übernimmt jeden einzeln. Nie generativ in den Buchtext: Beats sind
// Struktur-Stichpunkte, keine Prosa.
// Zwei Pfade, ein Prompt-Kern: agentisch (Provider mit Werkzeug-Protokoll, liest
// über die Lese-Werkzeuge des Buch-Chats) und klassisch (ein JSON-Call, die
// Vorschläge stehen als `vorschlaege` in der Antwort; Text-Grundierung über die
// semantisch nächsten Passagen).
// Deep-Doc: docs/plot-chat.md

import { _isLocal, _jsonOnly } from './state.js';

// Lese-Werkzeuge aus BOOK_CHAT_TOOLS, die der Plot-Chat anbietet. Handler +
// Schemas teilt er mit dem Buch-Chat (routes/jobs/book-chat-tools) — eine
// Quelle, kein Drift. Bewusst ohne Stil-/Lektorat-/Revisions-/Bild-Werkzeuge:
// die beantworten keine Plotfrage und kosten pro Runde Input-Tokens.
export const PLOT_CHAT_READ_TOOL_NAMES = [
  'get_plot_board',
  'list_chapters',
  'list_figures',
  'get_figure_profile',
  'get_figure_relations',
  'get_figure_mentions',
  'list_scenes',
  'list_locations',
  'get_location_profile',
  'get_timeline',
  'get_figure_age',
  'list_world_facts',
  'list_werkstatt_drafts',
  'get_werkstatt_draft',
  'get_motifs',
  'search_similar',
  'search_passages',
  'get_chapter_text',
  'get_pages',
  'get_book_settings',
  'list_ideen',
  'list_continuity_issues',
  'get_reviews',
];

// Teilmenge für lokale Provider (kein Prompt-Caching, kleineres Modell): der
// volle Katalog kostet jede Runde den ganzen Werkzeug-Block, und ein kleines
// Modell wählt aus wenigen Werkzeugen zuverlässiger.
export const PLOT_CHAT_SLIM_READ_TOOL_NAMES = [
  'get_plot_board',
  'list_chapters',
  'list_figures',
  'get_figure_profile',
  'list_scenes',
  'list_world_facts',
  'get_werkstatt_draft',
  'search_similar',
  'search_passages',
  'get_chapter_text',
];

export const PLOT_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Werkzeug-Iterationen erreicht — keine weiteren Lese-Aufrufe mehr. '
  + 'Fasse JETZT aus dem Gesammelten die bestmögliche Antwort zusammen und liefere sie über `final_answer`. '
  + 'Bereits abgegebene Vorschläge bleiben gültig; wiederhole sie nicht. Sprache der Antwort: die der Userfrage.';

const _BEGRUENDUNG = { type: 'string', description: 'Ein bis zwei Sätze: warum diese Änderung den Plot stärkt (Bezug auf Figur, Bogen, Szene oder Text). Pflicht.' };
const _FIGUREN = {
  type: 'array',
  items: { type: 'string' },
  description: 'Beteiligte Figuren — Name oder fig_id aus der Figurenliste bzw. Name einer Werkstatt-Figur. Bei einer Änderung ersetzt die Liste die bisherige vollständig.',
};

/**
 * Vorschlags-Werkzeuge + final_answer. Die Lese-Werkzeuge kommen aus
 * BOOK_CHAT_TOOLS (Filter über PLOT_CHAT_READ_TOOL_NAMES im Job).
 */
export const PLOT_CHAT_PROPOSE_TOOLS = [
  {
    name: 'propose_beat',
    description: 'Schlägt EINEN Beat vor: ohne beat_id einen NEUEN Beat, mit beat_id eine ÄNDERUNG an einem bestehenden (nur die mitgegebenen Felder ändern sich). Wird NICHT gespeichert — der User übernimmt jeden Vorschlag einzeln. Titel = prägnanter Handlungspunkt (3–10 Wörter), Beschreibung = Stichpunkte, NIE ausformulierte Prosa. Neue Beats lassen sich nicht referenzieren; neue Akte/Stränge derselben Antwort schon (act_ref/thread_ref). Zum Verschieben eines bestehenden Beats: propose_beat_move.',
    input_schema: {
      type: 'object',
      properties: {
        beat_id: { type: 'integer', description: 'Nur bei ÄNDERUNG: id des bestehenden Beats (aus dem Board).' },
        act_id: { type: 'integer', description: 'Nur bei NEUEM Beat: Ziel-Akt (id aus dem Board).' },
        act_ref: { type: 'integer', description: 'Nur bei NEUEM Beat statt act_id: `ref` eines in DIESER Antwort vorgeschlagenen neuen Akts.' },
        thread_id: { type: 'integer', description: 'Nur bei NEUEM Beat, optional: Strang (id aus dem Board). Ohne = „ohne Strang".' },
        thread_ref: { type: 'integer', description: 'Nur bei NEUEM Beat statt thread_id: `ref` eines in DIESER Antwort vorgeschlagenen neuen Strangs.' },
        after_beat_id: { type: 'integer', description: 'Nur bei NEUEM Beat, optional: hinter diesem Beat derselben Zelle einreihen. Ohne = ans Ende.' },
        at_start: { type: 'boolean', description: 'Nur bei NEUEM Beat, optional: an den Anfang der Zelle.' },
        titel: { type: 'string', description: 'Titel (Pflicht bei neuem Beat, max. 200 Zeichen).' },
        beschreibung: { type: 'string', description: 'Stichpunkte zum Inhalt (Konflikt, Wendung, Ziel). Keine Prosa.' },
        intensitaet: { type: 'integer', description: 'Spannung 1–5 für den Spannungsbogen.' },
        zeit: { type: 'string', description: 'Freitext-Zeitangabe innerhalb der Handlung, z.B. „Sommer 1987".' },
        chapter_id: { type: 'integer', description: 'Zielkapitel (chapter_id aus list_chapters/Board).' },
        figuren: _FIGUREN,
        verworfen: { type: 'boolean', description: 'Nur bei ÄNDERUNG: true = Beat ausmustern (bleibt erhalten, zählt nicht mehr), false = wieder aufnehmen.' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['begruendung'],
    },
  },
  {
    name: 'propose_beat_move',
    description: 'Schlägt vor, einen BESTEHENDEN Beat zu verschieben — in einen anderen Akt, einen anderen Strang oder an eine andere Stelle derselben Zelle. Wird NICHT gespeichert, der User übernimmt einzeln.',
    input_schema: {
      type: 'object',
      properties: {
        beat_id: { type: 'integer', description: 'id des Beats.' },
        act_id: { type: 'integer', description: 'Ziel-Akt (id). Ohne = bleibt im bisherigen Akt.' },
        act_ref: { type: 'integer', description: 'Statt act_id: `ref` eines in DIESER Antwort vorgeschlagenen neuen Akts.' },
        thread_id: { type: 'integer', description: 'Ziel-Strang (id). Ohne = bleibt im bisherigen Strang.' },
        thread_ref: { type: 'integer', description: 'Statt thread_id: `ref` eines in DIESER Antwort vorgeschlagenen neuen Strangs.' },
        ohne_strang: { type: 'boolean', description: 'true = aus dem Strang lösen („ohne Strang").' },
        after_beat_id: { type: 'integer', description: 'Hinter diesem Beat der Zielzelle einreihen. Ohne (und ohne at_start) = ans Ende.' },
        at_start: { type: 'boolean', description: 'An den Anfang der Zielzelle.' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['beat_id', 'begruendung'],
    },
  },
  {
    name: 'propose_act',
    description: 'Schlägt einen NEUEN Akt (Spalte) vor oder — mit act_id — eine Umbenennung. Wird NICHT gespeichert, der User übernimmt einzeln. Das Ergebnis trägt `ref`, auf das propose_beat/propose_beat_move derselben Antwort per act_ref verweisen können.',
    input_schema: {
      type: 'object',
      properties: {
        act_id: { type: 'integer', description: 'Nur bei Umbenennung: id des bestehenden Akts.' },
        name: { type: 'string', description: 'Name des Akts (max. 120 Zeichen). Pflicht.' },
        thread_id: { type: 'integer', description: 'Nur bei neuem Akt, optional: Akt gehört nur diesem Strang (eigene Aktstruktur). Ohne = geteilter Akt für alle Stränge.' },
        after_act_id: { type: 'integer', description: 'Nur bei neuem Akt, optional: hinter diesem Akt (desselben Bereichs) einreihen. Ohne = ans Ende.' },
        at_start: { type: 'boolean', description: 'Nur bei neuem Akt, optional: als ersten Akt einreihen.' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['name', 'begruendung'],
    },
  },
  {
    name: 'propose_thread',
    description: 'Schlägt einen NEUEN Handlungsstrang (Swimlane, oft je Hauptfigur) vor oder — mit thread_id — eine Umbenennung/neue Hauptfigur. Wird NICHT gespeichert, der User übernimmt einzeln. Das Ergebnis trägt `ref` für thread_ref.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id: { type: 'integer', description: 'Nur bei Änderung: id des bestehenden Strangs.' },
        name: { type: 'string', description: 'Name des Strangs (max. 120 Zeichen). Pflicht.' },
        figur: { type: 'string', description: 'Optional: Hauptfigur des Strangs — Name oder fig_id einer Katalog-Figur oder Name einer Werkstatt-Figur.' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['name', 'begruendung'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die Antwort an den User. ALLERLETZTER Aufruf — Pflicht-Endpunkt. Markdown erlaubt. Hast du Änderungen vorgeschlagen, sage kurz, was sie bewirken; wiederhole sie nicht im Volltext — sie stehen unten zum Übernehmen bereit. Sprache: die der Userfrage.',
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User, Markdown erlaubt. Pflichtfeld.' },
      },
      required: ['antwort'],
    },
  },
];

// Klassischer Pfad: Antwort-Schema. Ein Vorschlag ist {werkzeug, …Felder des
// gleichnamigen Werkzeugs}; nur werkzeug + begruendung sind Pflicht, damit ein
// Modell mit Constrained Decoding nicht jedes Feld erfinden muss. Die Feldnamen
// sind dieselben wie in PLOT_CHAT_PROPOSE_TOOLS — derselbe Handler validiert.
const _PROPOSE_FIELDS = (() => {
  const out = {};
  for (const t of PLOT_CHAT_PROPOSE_TOOLS) {
    if (t.name === 'final_answer') continue;
    for (const [k, v] of Object.entries(t.input_schema.properties)) {
      if (!out[k]) out[k] = { type: v.type, ...(v.items ? { items: v.items } : {}) };
    }
  }
  return out;
})();
export const PLOT_CHAT_CLASSIC_TOOL_NAMES = PLOT_CHAT_PROPOSE_TOOLS.map(t => t.name).filter(n => n !== 'final_answer');
export const SCHEMA_PLOT_CHAT_CLASSIC = {
  type: 'object',
  additionalProperties: false,
  required: ['antwort', 'vorschlaege'],
  properties: {
    antwort: { type: 'string' },
    vorschlaege: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['werkzeug', 'begruendung'],
        properties: { werkzeug: { type: 'string', enum: PLOT_CHAT_CLASSIC_TOOL_NAMES }, ..._PROPOSE_FIELDS },
      },
    },
  },
};

// Feldliste je Werkzeug für den klassischen Prompt (aus den Werkzeug-Schemas
// abgeleitet, damit die beiden Pfade nicht auseinanderlaufen).
function _classicToolLines() {
  return PLOT_CHAT_PROPOSE_TOOLS.filter(t => t.name !== 'final_answer').map(t => {
    const props = Object.entries(t.input_schema.properties).map(([k, v]) => `    · ${k}: ${v.description}`);
    return [`  werkzeug "${t.name}": ${t.description}`, ...props].join('\n');
  });
}

/**
 * Block der früheren Vorschläge dieser Session (Art, Titel, übernommen/verworfen/
 * offen). Steht im volatilen Teil des System-Prompts.
 * @param {Array<{type,label,state}>} list
 */
export function buildPlotProposalMemoryBlock(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  const STATE = { applied: 'übernommen', discarded: 'vom User verworfen', open: 'noch offen' };
  const lines = list.map(p => `- ${p.type}: «${p.label}» — ${STATE[p.state] || STATE.open}`);
  return 'BISHERIGE VORSCHLÄGE IN DIESEM GESPRÄCH (übernommene stehen schon im Board oben; verworfene nicht erneut vorschlagen, ausser der User bittet darum; offene nicht doppelt vorschlagen):\n'
    + lines.join('\n');
}

/**
 * System-Prompt als zwei Cache-Blöcke (wie der agentische Buch-Chat):
 *   Block 1 (ttl '1h'): Rolle, Regeln, Werkzeug-Strategie, Buch-Kontext — über die
 *     Session stabil.
 *   Block 2 (cache:false): Board-Outline, Figurenliste, frühere Vorschläge und die
 *     Textpassagen zur Frage — ändert sich mit jeder Übernahme bzw. Frage, darum
 *     ohne Breakpoint und am Ende.
 *
 * @param {string} bookName
 * @param {object} ctx { mode ('agent'|'classic'), maxToolIter, toolNames,
 *                       bookContext, boardOutline, figurenOutline,
 *                       proposalMemory, passages (classic immer; agent als
 *                       Erst-Kontext, null = ohne Embedding-Endpunkt) }
 */
export function buildPlotChatSystemPrompt(bookName, ctx = {}) {
  const classic = ctx.mode === 'classic';
  const maxToolIter = Number(ctx.maxToolIter) || 8;
  const offered = Array.isArray(ctx.toolNames) ? new Set(ctx.toolNames) : null;
  const has = (n) => !offered || offered.has(n);
  const ifAny = (names, line) => (names.some(has) ? [line] : []);
  const bookContext = String(ctx.bookContext || '').trim();

  const stable = [
    'Du bist Dramaturgin / Dramaturg und Plot-Coach für ein Buchprojekt. Du entwickelst mit dem Autor / der Autorin im Gespräch die Handlung auf dem Beat-Board der Plot-Werkstatt: Akte (Spalten), Beats (Handlungspunkte) und Handlungsstränge (Swimlanes, oft je Hauptfigur).',
    '',
    `Buch: «${bookName}»`,
    '',
    'Was du tust:',
    '- Du denkst mit: Struktur, Wendepunkte, Spannungsbogen, Setup/Payoff, Kausalität, Figurenbögen (Want/Need/Wound/Lie aus der Figuren-Werkstatt), Strang-Verflechtung.',
    '- Du gründest jeden Vorschlag in der Buchrealität: im Board, in den Figuren, im geschriebenen Text, in Szenen, Zeitstrahl und Weltregeln. Was geschrieben ist, gilt — ein Beat darf dem Text nicht widersprechen, ausser der User will es ändern.',
    '- Konkrete Änderungen am Board gibst du über die Vorschlags-Werkzeuge ab — nicht nur als Prosa. Bittet der User um Beats, Akte, Stränge oder Umbauten, MUSST du sie als Vorschläge abgeben.',
    '',
    ...(classic ? [
      'Vorschläge (nichts wird gespeichert — der User übernimmt jeden Vorschlag einzeln) gibst du im Feld `vorschlaege` deiner JSON-Antwort ab. Jeder Eintrag nennt sein `werkzeug` und dessen Felder:',
      ..._classicToolLines(),
      'Jeder Vorschlag bekommt in Reihenfolge eine Nummer `ref` (1, 2, 3 …). Baust du etwas Neues auf (z.B. neue Aktstruktur mit Beats darin), stelle zuerst die Akte/Stränge in die Liste und verweise in den Beats per act_ref/thread_ref auf deren Nummer.',
      'ids nur aus dem Board unten — ein Vorschlag mit unbekannter id wird verworfen. Lass Felder weg, die du nicht setzen willst.',
    ] : [
      'Vorschlags-Werkzeuge (nichts wird gespeichert — der User übernimmt jeden Vorschlag einzeln):',
      '- `propose_beat` — neuer Beat (mit act_id bzw. act_ref) oder Änderung eines bestehenden (beat_id, nur geänderte Felder).',
      '- `propose_beat_move` — bestehenden Beat in anderen Akt/Strang/Platz verschieben.',
      '- `propose_act` — neuer Akt oder Umbenennung.',
      '- `propose_thread` — neuer Strang (optional mit Hauptfigur) oder Änderung.',
      'Ein Vorschlag pro Aufruf; mehrere Vorschläge = mehrere Aufrufe, gebündelt in einer Runde. Baust du etwas Neues auf (z.B. neue Aktstruktur mit Beats darin), schlage zuerst die Akte/Stränge vor und verweise in den Beats per act_ref/thread_ref auf deren `ref`.',
      'Meldet ein Vorschlags-Werkzeug einen Fehler (unbekannte id, falscher Akt), korrigiere den Aufruf — rate keine ids, sie stehen im Board unten.',
    ]),
    'Löschen kannst du nicht vorschlagen. Statt einen Beat zu löschen, schlage vor, ihn zu verwerfen (`propose_beat` mit beat_id und verworfen: true).',
    'Schlage nicht ungefragt das ganze Board um. Bei offenen Fragen („was meinst du?") antworte erst inhaltlich und biete Vorschläge an; bei klaren Aufträgen („mach mir drei Beats für …") schlage direkt vor.',
    '',
    'NIE GENERATIV IN DEN BUCHTEXT: Beats sind Struktur-Stichpunkte — Titel als prägnanter Handlungspunkt, Beschreibung als Stichpunkte (was passiert, welcher Konflikt, welche Wendung, was steht auf dem Spiel). Du schreibst keine Szenen, keine Dialoge, keine Romanprosa, auch nicht „als Beispiel".',
    '',
  ];
  if (classic) {
    stable.push(
      'Grundlage: das Board und die Figurenliste unten sowie die TEXTPASSAGEN (die semantisch nächsten Stellen des Manuskripts zur Frage, falls vorhanden). Was dort nicht steht, kennst du nicht — sage das, statt zu raten.',
      '',
      'ANTWORTFORMAT: ein JSON-Objekt {"antwort": "…", "vorschlaege": [ … ]}. `antwort` ist deine Antwort an den User (Markdown erlaubt), `vorschlaege` die Liste der Board-Vorschläge (leer, wenn keine). Sprache: die der Userfrage.',
      ...(bookContext ? ['', bookContext] : []),
    );
    return _finish(stable, ctx, { classic: true });
  }
  stable.push(
    'Lese-Werkzeuge:',
    '- Das aktuelle Board steht unten vollständig im Prompt (`get_plot_board` brauchst du nur nach eigenen Rückfragen, z.B. für Strang-Erbschaften).',
    ...ifAny(['search_similar'], '- Die TEXTPASSAGEN unten sind schon die semantisch nächsten Stellen zur aktuellen Frage — prüfe sie zuerst, bevor du liest.'),
    ...ifAny(['list_figures', 'get_figure_profile', 'get_figure_relations'], '- Figuren, Beziehungen → list_figures, get_figure_profile, get_figure_relations'),
    ...ifAny(['list_werkstatt_drafts', 'get_werkstatt_draft'], '- Geplante Figuren mit psychologischem Kern (Want/Need/Wound/Lie, Bogen) → list_werkstatt_drafts, get_werkstatt_draft'),
    ...ifAny(['list_scenes', 'get_timeline'], '- Was schon geschrieben ist (Szenen, Ereignisse in Reihenfolge) → list_scenes, get_timeline'),
    ...ifAny(['search_similar', 'search_passages'], `- Stellen im Text → ${has('search_similar') ? 'search_similar (nach Sinn), ' : ''}search_passages (Wortlaut)`),
    ...ifAny(['get_chapter_text', 'get_pages'], '- Ganze Kapitel lesen (teuer, nur wenn der Zusammenhang nötig ist) → get_chapter_text'),
    ...ifAny(['list_world_facts'], '- Weltregeln, gegen die ein Beat nicht verstossen darf → list_world_facts'),
    ...ifAny(['get_motifs'], '- Themen & Motive → get_motifs'),
    '',
    `Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, nicht ein Aufruf). Bündle unabhängige Aufrufe in EINER Runde. Vorschlags-Aufrufe zählen mit — gib alle Vorschläge möglichst in einer Runde ab.`,
    'Liefere die Antwort IMMER über `final_answer`. Sprache: passe dich der Userfrage an, nicht diesem Prompt.',
    ...(bookContext ? ['', bookContext] : []),
  );

  if (_isLocal) {
    stable.push(
      '',
      'WERKZEUG-DISZIPLIN (verbindlich):',
      '- Rufe NUR Werkzeuge aus der bereitgestellten Liste; erfinde keine Namen oder Parameter.',
      '- Rufe Werkzeuge über den Werkzeug-Mechanismus, nie als Text oder JSON in der Antwort.',
      '- ids nur aus dem Board bzw. aus Werkzeug-Ergebnissen übernehmen.',
      '- Höre auf zu lesen, sobald du antworten kannst, und rufe `final_answer`.',
    );
  }

  return _finish(stable, ctx, { classic: false });
}

// Volatiler Block (Board, Figuren, Gedächtnis, Textpassagen zur Frage)
// und JSON-Pflicht des klassischen Pfads — gemeinsam für beide Modi.
function _finish(stable, ctx, { classic }) {
  const volatile = [
    '=== AKTUELLES BEAT-BOARD (Stand dieser Frage; [#id] = id für die Vorschläge) ===',
    String(ctx.boardOutline || '').trim() || '(Board ist leer — noch keine Akte angelegt.)',
  ];
  const fig = String(ctx.figurenOutline || '').trim();
  if (fig) volatile.push('', '=== FIGUREN (Name · fig_id bzw. Werkstatt) ===', fig);
  const mem = String(ctx.proposalMemory || '').trim();
  if (mem) volatile.push('', mem);
  // Textpassagen: klassisch immer (einzige Text-Grundierung), agentisch als
  // Erst-Kontext nur mit Embedding-Endpunkt (ctx.passages = Array). Pro Frage andere
  // Bytes — darum hier im ungecachten Block am Ende, nie im gecachten Block 1.
  if (classic || Array.isArray(ctx.passages)) {
    const passages = Array.isArray(ctx.passages) ? ctx.passages : [];
    volatile.push('', '=== TEXTPASSAGEN (semantisch nächste Stellen zur Frage) ===');
    if (passages.length) {
      if (!classic) {
        volatile.push('(Automatisch vorab geholt; Ausschnitte können unvollständig sein. Reichen sie, brauchst du kein Lese-Werkzeug — sonst weiter mit search_similar/get_chapter_text.)');
      }
      for (const p of passages) volatile.push(`--- ${p.title || p.kind || ''} ---`, String(p.text || '').trim());
    } else {
      volatile.push(classic
        ? '(keine — Embedding-Index fehlt oder kein Treffer; urteile über Board und Figuren)'
        : '(keine Treffer zur Frage — nutze bei Bedarf die Lese-Werkzeuge)');
    }
  }
  return [
    { text: stable.join('\n') + (classic ? _jsonOnly() : ''), ttl: '1h' },
    { text: volatile.join('\n'), cache: false },
  ];
}

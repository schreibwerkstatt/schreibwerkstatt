// Ideen-Chat (Panel im Ideen-Board). Arbeitet die Ideen und Pendenzen eines
// Buches im Gespräch durch und schlägt Änderungen vor (propose_idee /
// propose_idee_link). Ein Vorschlag schreibt NICHTS — der User übernimmt jeden
// einzeln. Kern: der Erledigt-Check (offene Pendenzen gegen den Text, mit Beleg)
// und Orte für Buch-Ideen ohne Anker. Nie generativ in den Buchtext: eine Idee
// ist ein Stichpunkt, keine Prosa.
// Zwei Pfade, ein Prompt-Kern: agentisch (Provider mit Werkzeug-Protokoll, liest
// über die Lese-Werkzeuge des Buch-Chats) und klassisch (ein JSON-Call, die
// Vorschläge stehen als `vorschlaege` in der Antwort; Text-Grundierung über die
// semantisch nächsten Passagen).
// Deep-Doc: docs/ideen-chat.md

import { _isLocal, _jsonOnly } from './state.js';

// Lese-Werkzeuge aus BOOK_CHAT_TOOLS, die der Ideen-Chat anbietet. Handler +
// Schemas teilt er mit dem Buch-Chat (routes/jobs/book-chat-tools). Schwerpunkt
// ist der Text (Erledigt-Check, Ortssuche); dazu die planenden Kataloge, an
// denen eine Idee hängen kann. `list_ideen` fehlt bewusst: die Ideen stehen
// vollständig im Prompt.
export const IDEEN_CHAT_READ_TOOL_NAMES = [
  'list_chapters',
  'get_pages',
  'get_chapter_text',
  'search_similar',
  'search_passages',
  'find_first_last_mention',
  'get_plot_board',
  'list_figures',
  'get_figure_profile',
  'list_scenes',
  'get_timeline',
  'list_world_facts',
  'list_werkstatt_drafts',
  'get_werkstatt_draft',
  'get_motifs',
  'list_research_items',
  'read_research_item',
  'list_continuity_issues',
  'get_reviews',
  'get_book_settings',
];

// Teilmenge für lokale Provider (kein Prompt-Caching, kleineres Modell).
export const IDEEN_CHAT_SLIM_READ_TOOL_NAMES = [
  'list_chapters',
  'get_pages',
  'get_chapter_text',
  'search_similar',
  'search_passages',
  'get_plot_board',
  'list_figures',
];

export const IDEEN_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Werkzeug-Iterationen erreicht — keine weiteren Lese-Aufrufe mehr. '
  + 'Fasse JETZT aus dem Gesammelten die bestmögliche Antwort zusammen und liefere sie über `final_answer`. '
  + 'Sage, welche Ideen du noch nicht prüfen konntest. Bereits abgegebene Vorschläge bleiben gültig; wiederhole sie nicht. '
  + 'Sprache der Antwort: die der Userfrage.';

const _BEGRUENDUNG = { type: 'string', description: 'Ein bis zwei Sätze: warum dieser Vorschlag stimmt (Bezug auf Text, Plot, Figur oder eine andere Idee). Pflicht.' };

/**
 * Vorschlags-Werkzeuge + final_answer. Die Lese-Werkzeuge kommen aus
 * BOOK_CHAT_TOOLS (Filter über IDEEN_CHAT_READ_TOOL_NAMES im Job).
 */
export const IDEEN_CHAT_PROPOSE_TOOLS = [
  {
    name: 'propose_idee',
    description: 'Schlägt EINE Idee vor: ohne idee_id eine NEUE Idee (startet als «offen»), mit idee_id eine ÄNDERUNG an einer bestehenden — Stufe (status), Ort (page_id bzw. chapter_id) und/oder Text (content); nur die mitgegebenen Felder ändern sich. Wird NICHT gespeichert — der User übernimmt jeden Vorschlag einzeln. Wer status «erledigt» vorschlägt, MUSS die einlösende Textstelle in `beleg` zitieren. Eine Idee ist ein Stichpunkt, NIE ausformulierte Prosa. Löschen gibt es nicht — statt dessen status «verworfen».',
    input_schema: {
      type: 'object',
      properties: {
        idee_id: { type: 'integer', description: 'Nur bei ÄNDERUNG: id der bestehenden Idee ([#id] aus der Ideenliste).' },
        content: { type: 'string', description: 'Text der Idee (Pflicht bei neuer Idee, max. 4000 Zeichen). Bei Änderung: der neue, vollständige Text — z.B. beim Zusammenführen einer Dublette.' },
        status: { type: 'string', description: 'Nur bei ÄNDERUNG: neue Stufe — eine der aktiven Stufen des Buches (siehe Liste unten).' },
        page_id: { type: 'integer', description: 'Ort: Abschnitt (page#-id aus der Gliederung). Bei Änderung: Buch-Idee zuordnen oder Abschnitts-Idee in einen anderen Abschnitt.' },
        chapter_id: { type: 'integer', description: 'Ort: Kapitel (chapter#-id aus der Gliederung). Statt page_id, nie beides.' },
        beleg: { type: 'string', description: 'Nur bei Stufen-Änderung: wörtliches, kurzes Zitat (max. 500 Zeichen) der Textstelle, die die Pendenz einlöst bzw. überholt. Pflicht bei «erledigt». Wird gegen den Abschnitt geprüft — ein Zitat, das dort nicht wörtlich steht, wird abgelehnt.' },
        beleg_page_id: { type: 'integer', description: 'Abschnitt (page_id), in dem das Zitat steht. Pflicht zu jedem beleg.' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['begruendung'],
    },
  },
  {
    name: 'propose_idee_link',
    description: 'Schlägt vor, eine Idee mit einem planenden Katalog-Eintrag desselben Buches zu verknüpfen: Plot-Beat, Handlungsstrang, Motiv, Werkstatt-Figur oder Recherche-Fundstück. Wird NICHT gespeichert, der User übernimmt einzeln. Für eine in DIESER Antwort neu vorgeschlagene Idee: idee_ref statt idee_id.',
    input_schema: {
      type: 'object',
      properties: {
        idee_id: { type: 'integer', description: 'id der bestehenden Idee.' },
        idee_ref: { type: 'integer', description: 'Statt idee_id: `ref` einer in DIESER Antwort vorgeschlagenen neuen Idee.' },
        target_kind: { type: 'string', enum: ['research', 'beat', 'thread', 'motif', 'draft'], description: 'Art des Ziels.' },
        target_id: { type: 'integer', description: 'id des Ziels aus der Zielliste (z.B. [beat#12] → 12).' },
        begruendung: _BEGRUENDUNG,
      },
      required: ['target_kind', 'target_id', 'begruendung'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die Antwort an den User. ALLERLETZTER Aufruf — Pflicht-Endpunkt. Markdown erlaubt. Hast du Änderungen vorgeschlagen, fasse sie kurz zusammen (z.B. „3 Pendenzen sind erledigt, 2 Buch-Ideen haben einen Ort"); wiederhole sie nicht im Volltext — sie stehen unten zum Übernehmen bereit. Sprache: die der Userfrage.',
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
// gleichnamigen Werkzeugs}; nur werkzeug + begruendung sind Pflicht. Die
// Feldnamen sind dieselben wie in IDEEN_CHAT_PROPOSE_TOOLS — derselbe Handler validiert.
const _PROPOSE_FIELDS = (() => {
  const out = {};
  for (const t of IDEEN_CHAT_PROPOSE_TOOLS) {
    if (t.name === 'final_answer') continue;
    for (const [k, v] of Object.entries(t.input_schema.properties)) {
      if (!out[k]) out[k] = { type: v.type, ...(v.enum ? { enum: v.enum } : {}) };
    }
  }
  return out;
})();
export const IDEEN_CHAT_CLASSIC_TOOL_NAMES = IDEEN_CHAT_PROPOSE_TOOLS.map(t => t.name).filter(n => n !== 'final_answer');
export const SCHEMA_IDEEN_CHAT_CLASSIC = {
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
        properties: { werkzeug: { type: 'string', enum: IDEEN_CHAT_CLASSIC_TOOL_NAMES }, ..._PROPOSE_FIELDS },
      },
    },
  },
};

function _classicToolLines() {
  return IDEEN_CHAT_PROPOSE_TOOLS.filter(t => t.name !== 'final_answer').map(t => {
    const props = Object.entries(t.input_schema.properties).map(([k, v]) => `    · ${k}: ${v.description}`);
    return [`  werkzeug "${t.name}": ${t.description}`, ...props].join('\n');
  });
}

/**
 * Block der früheren Vorschläge dieser Session (Art, Inhalt, übernommen/verworfen/
 * offen). Steht im volatilen Teil des System-Prompts.
 * @param {Array<{type,label,state}>} list
 */
export function buildIdeenProposalMemoryBlock(list = []) {
  if (!Array.isArray(list) || !list.length) return '';
  const STATE = { applied: 'übernommen', discarded: 'vom User verworfen', open: 'noch offen' };
  const lines = list.map(p => `- ${p.type}: ${p.label} — ${STATE[p.state] || STATE.open}`);
  return 'BISHERIGE VORSCHLÄGE IN DIESEM GESPRÄCH (übernommene stehen schon in der Ideenliste oben; verworfene nicht erneut vorschlagen, ausser der User bittet darum; offene nicht doppelt vorschlagen):\n'
    + lines.join('\n');
}

/**
 * System-Prompt als zwei Cache-Blöcke (wie der Plot-Chat):
 *   Block 1 (ttl '1h'): Rolle, Regeln, Werkzeug-Strategie, Buch-Kontext.
 *   Block 2 (cache:false): Ideenliste, Stufen, Gliederung, Link-Ziele, frühere
 *     Vorschläge und die Textpassagen zur Frage — ändert sich mit jeder
 *     Übernahme bzw. Frage, darum ohne Breakpoint und am Ende.
 *
 * @param {string} bookName
 * @param {object} ctx { mode ('agent'|'classic'), maxToolIter, toolNames,
 *                       bookContext, ideenOutline, gliederungOutline,
 *                       targetsOutline, stages, proposalMemory, passages }
 */
export function buildIdeenChatSystemPrompt(bookName, ctx = {}) {
  const classic = ctx.mode === 'classic';
  const maxToolIter = Number(ctx.maxToolIter) || 8;
  const offered = Array.isArray(ctx.toolNames) ? new Set(ctx.toolNames) : null;
  const has = (n) => !offered || offered.has(n);
  const ifAny = (names, line) => (names.some(has) ? [line] : []);
  const bookContext = String(ctx.bookContext || '').trim();

  const stable = [
    'Du bist Lektorin / Lektor und Projektbegleitung für ein Buchprojekt. Du arbeitest mit dem Autor / der Autorin die IDEEN des Buches durch: Einfälle für mögliche Fortsetzungen und Pendenzen an Stellen im Text („Beleg nachtragen", „hier fehlt noch die Szene mit …").',
    '',
    `Buch: «${bookName}»`,
    '',
    'Eine Idee hängt an höchstens einem Ort: an einem Abschnitt, an einem Kapitel oder — ohne Ort — nur am Buch. Ihre Stufe ist «offen», «in_arbeit», «erledigt» oder «verworfen» (verworfen = bewusst fallengelassen, nicht gelöscht).',
    '',
    'Was du tust:',
    '- ERLEDIGT-CHECK: Prüfe offene Pendenzen gegen den aktuellen Text. Löst der Text eine Pendenz ein, schlage «erledigt» vor und zitiere die Stelle wörtlich in `beleg` (mit beleg_page_id). Ist sie nur teilweise eingelöst, sage was fehlt — kein «erledigt». Hat der Text die Idee überholt (widerspricht ihr, macht sie gegenstandslos), schlage «verworfen» vor und belege auch das.',
    '- ORTE FINDEN: Buch-Ideen ohne Ort bekommen einen Abschnitt oder ein Kapitel, an dem sie sich einlösen lassen. Suche die Stelle im Text, statt nach dem Titel zu raten.',
    '- AUFRÄUMEN: Erkenne Dubletten (zwei Ideen, ein Gedanke) — schlage vor, eine mit zusammengeführtem Text zu behalten und die andere zu verwerfen. Schlage Verknüpfungen zu Beats, Strängen, Motiven, Werkstatt-Figuren oder Recherche-Fundstücken vor, wenn eine Idee erkennbar dazu gehört.',
    '- NEUE IDEEN: Nur auf Wunsch oder wenn sich beim Lesen eine echte Lücke zeigt — als knappe Pendenz mit Ort.',
    '',
    'Grundsätze:',
    '- Was geschrieben ist, gilt. Ein «erledigt» ohne Textstelle, die es trägt, ist eine Behauptung — die gibst du nicht ab. Zitiere nur, was du tatsächlich gelesen hast.',
    '- Prüfe lieber wenige Ideen gründlich als alle oberflächlich. Sage am Ende, welche du geprüft hast und welche noch offen sind.',
    '- Eine verworfene Idee schlägst du nicht wieder vor; eine erledigte öffnest du nur wieder, wenn der Text die Einlösung verloren hat.',
    '- NIE GENERATIV IN DEN BUCHTEXT: Du schreibst keine Szenen, Dialoge oder Romanprosa, auch nicht „als Beispiel". Eine Idee ist ein Stichpunkt.',
    '',
    ...(classic ? [
      'Vorschläge (nichts wird gespeichert — der User übernimmt jeden Vorschlag einzeln) gibst du im Feld `vorschlaege` deiner JSON-Antwort ab. Jeder Eintrag nennt sein `werkzeug` und dessen Felder:',
      ..._classicToolLines(),
      'Jeder Vorschlag bekommt in Reihenfolge eine Nummer `ref` (1, 2, 3 …); eine Verknüpfung zu einer neuen Idee derselben Antwort verweist per idee_ref auf deren Nummer.',
      'ids nur aus den Listen unten — ein Vorschlag mit unbekannter id wird verworfen. Lass Felder weg, die du nicht setzen willst.',
    ] : [
      'Vorschlags-Werkzeuge (nichts wird gespeichert — der User übernimmt jeden Vorschlag einzeln):',
      '- `propose_idee` — neue Idee, oder Änderung einer bestehenden (idee_id): Stufe, Ort, Text.',
      '- `propose_idee_link` — Idee mit Beat/Strang/Motiv/Werkstatt-Figur/Fundstück verknüpfen.',
      'Ein Vorschlag pro Aufruf; mehrere Vorschläge = mehrere Aufrufe, gebündelt in einer Runde.',
      'Meldet ein Vorschlags-Werkzeug einen Fehler (unbekannte id, abgeschaltete Stufe, fehlender Beleg), korrigiere den Aufruf — rate keine ids, sie stehen unten.',
    ]),
    'Bei offenen Fragen („was ist noch offen?") antworte erst inhaltlich; bei klaren Aufträgen („prüf die Pendenzen in Kapitel 3", „such den Buch-Ideen einen Ort") schlage direkt vor.',
    '',
  ];
  if (classic) {
    stable.push(
      'Grundlage: die Ideenliste und die Gliederung unten sowie die TEXTPASSAGEN (die semantisch nächsten Stellen des Manuskripts zur Frage, falls vorhanden). Was dort nicht steht, kennst du nicht — ein «erledigt» schlägst du nur vor, wenn die einlösende Stelle in den TEXTPASSAGEN steht.',
      '',
      'ANTWORTFORMAT: ein JSON-Objekt {"antwort": "…", "vorschlaege": [ … ]}. `antwort` ist deine Antwort an den User (Markdown erlaubt), `vorschlaege` die Liste der Vorschläge (leer, wenn keine). Sprache: die der Userfrage.',
      ...(bookContext ? ['', bookContext] : []),
    );
    return _finish(stable, ctx, { classic: true });
  }
  stable.push(
    'Lese-Werkzeuge:',
    '- Alle Ideen, die Gliederung und die verknüpfbaren Ziele stehen unten vollständig im Prompt.',
    ...ifAny(['search_similar'], '- Die TEXTPASSAGEN unten sind schon die semantisch nächsten Stellen zur aktuellen Frage — prüfe sie zuerst, bevor du liest.'),
    ...ifAny(['get_pages', 'get_chapter_text'], '- Pendenz an einem Abschnitt prüfen → get_pages mit dessen page_id (mehrere Abschnitte in EINEM Aufruf); Pendenz an einem Kapitel → get_chapter_text'),
    ...ifAny(['search_similar', 'search_passages'], `- Ort für eine Buch-Idee oder Einlösung irgendwo im Buch → ${has('search_similar') ? 'search_similar (nach Sinn), ' : ''}search_passages (Wortlaut)`),
    ...ifAny(['find_first_last_mention'], '- Wo etwas zum ersten / letzten Mal vorkommt → find_first_last_mention'),
    ...ifAny(['get_plot_board', 'get_motifs', 'list_werkstatt_drafts', 'list_research_items'], '- Inhalt der Verknüpfungsziele → get_plot_board, get_motifs, list_werkstatt_drafts, list_research_items'),
    ...ifAny(['list_figures', 'list_scenes', 'get_timeline', 'list_world_facts'], '- Figuren, Szenen, Zeitstrahl, Weltregeln → list_figures, list_scenes, get_timeline, list_world_facts'),
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
      '- ids nur aus den Listen unten bzw. aus Werkzeug-Ergebnissen übernehmen.',
      '- Höre auf zu lesen, sobald du antworten kannst, und rufe `final_answer`.',
    );
  }

  return _finish(stable, ctx, { classic: false });
}

// Volatiler Block (Ideen, Stufen, Gliederung, Ziele, Gedächtnis, Textpassagen)
// und JSON-Pflicht des klassischen Pfads — gemeinsam für beide Modi.
function _finish(stable, ctx, { classic }) {
  const stages = Array.isArray(ctx.stages) && ctx.stages.length ? ctx.stages : ['offen', 'erledigt'];
  const volatile = [
    `=== AKTIVE STUFEN DIESES BUCHES (nur diese als status vorschlagen) === ${stages.join(', ')}`,
    '',
    '=== IDEEN (Stand dieser Frage; [#id] = idee_id für die Vorschläge) ===',
    String(ctx.ideenOutline || '').trim() || '(noch keine Ideen angelegt)',
  ];
  const glied = String(ctx.gliederungOutline || '').trim();
  if (glied) volatile.push('', '=== GLIEDERUNG (chapter#id / page#id = chapter_id / page_id) ===', glied);
  const targets = String(ctx.targetsOutline || '').trim();
  if (targets) volatile.push('', '=== VERKNÜPFBARE ZIELE (kind#id = target_kind / target_id) ===', targets);
  const mem = String(ctx.proposalMemory || '').trim();
  if (mem) volatile.push('', mem);
  // Textpassagen: klassisch immer (einzige Text-Grundierung), agentisch als
  // Erst-Kontext nur mit Embedding-Endpunkt (ctx.passages = Array).
  if (classic || Array.isArray(ctx.passages)) {
    const passages = Array.isArray(ctx.passages) ? ctx.passages : [];
    volatile.push('', '=== TEXTPASSAGEN (semantisch nächste Stellen zur Frage) ===');
    if (passages.length) {
      if (!classic) {
        volatile.push('(Automatisch vorab geholt; Ausschnitte können unvollständig sein. Für einen Erledigt-Check lies den Abschnitt der Pendenz selbst.)');
      }
      for (const p of passages) volatile.push(`--- ${p.title || p.kind || ''} ---`, String(p.text || '').trim());
    } else {
      volatile.push(classic
        ? '(keine — Embedding-Index fehlt oder kein Treffer; ohne Textstelle kein «erledigt»)'
        : '(keine Treffer zur Frage — nutze bei Bedarf die Lese-Werkzeuge)');
    }
  }
  return [
    { text: stable.join('\n') + (classic ? _jsonOnly() : ''), ttl: '1h' },
    { text: volatile.join('\n'), cache: false },
  ];
}

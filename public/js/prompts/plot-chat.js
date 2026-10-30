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
import { buildPassageBlockLines } from './chat-pre-context.js';
import { toolMentions } from './chat-tools/mentions.js';
import { _reihenfolgeRegel } from './plot/board.js';
import { buildProposalMemoryBlock } from './proposal-memory.js';

export const PLOT_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Werkzeug-Iterationen erreicht — keine weiteren Lese-Aufrufe mehr. '
  + 'Fasse JETZT aus dem Gesammelten die bestmögliche Antwort zusammen und liefere sie über `final_answer`. '
  + 'Rufe kein anderes Werkzeug mehr auf als `final_answer` — weitere Aufrufe werden nicht ausgeführt. '
  + 'Bereits abgegebene Vorschläge bleiben gültig; wiederhole sie nicht. Sprache der Antwort: die der Userfrage.';

const _BEGRUENDUNG = { type: 'string', description: 'Ein bis zwei Sätze: warum diese Änderung den Plot stärkt (Bezug auf Figur, Bogen, Szene oder Text). Pflicht.' };
const _FIGUREN = {
  type: 'array',
  items: { type: 'string' },
  description: 'Beteiligte Figuren — Kennung (fig_id bzw. draft#id) oder eindeutiger Name aus der Figurenliste. Bei Änderung ersetzt sie die bisherige Liste.',
};
const _LEEREN = {
  type: 'array',
  items: { type: 'string', enum: ['beschreibung', 'zeit', 'kapitel', 'intensitaet', 'figuren'] },
  description: 'Nur bei ÄNDERUNG: Felder leeren («kapitel» = vom Kapitel lösen).',
};

/**
 * Vorschlags-Werkzeuge + final_answer. Die Lese-Werkzeuge kommen aus
 * gemeinsamen Katalog (./chat-tools/, Spalte `plot` in access.js).
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
        chapter_id: { type: 'integer', description: 'Zielkapitel (chapter_id aus Board oder Gliederung).' },
        figuren: _FIGUREN,
        verworfen: { type: 'boolean', description: 'Nur bei ÄNDERUNG: true = Beat ausmustern (bleibt erhalten, zählt nicht mehr), false = wieder aufnehmen.' },
        leeren: _LEEREN,
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
    description: 'Schlägt einen NEUEN Akt (Spalte) vor oder — mit act_id — eine Umbenennung. Wird NICHT gespeichert, der User übernimmt einzeln. Das Ergebnis trägt `ref` für act_ref. Strang ohne eigene Aktstruktur: sie entsteht beim Übernehmen als Kopie der geteilten Akte.',
    input_schema: {
      type: 'object',
      properties: {
        act_id: { type: 'integer', description: 'Nur bei Umbenennung: id des bestehenden Akts.' },
        name: { type: 'string', description: 'Name des Akts (max. 120 Zeichen). Pflicht.' },
        thread_id: { type: 'integer', description: 'Nur bei neuem Akt, optional: Akt gehört nur diesem Strang (eigene Aktstruktur). Ohne = geteilter Akt für alle Stränge.' },
        thread_ref: { type: 'integer', description: 'Statt thread_id: `ref` eines neuen Strangs dieser Antwort.' },
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
        figur: { type: 'string', description: 'Optional: Hauptfigur — Kennung (fig_id bzw. draft#id) oder eindeutiger Name aus der Figurenliste.' },
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
 * Block der früheren Vorschläge dieser Session (Art, Titel, übernommen/rückgängig/
 * verworfen/offen). Steht im Vorspann der Frage.
 * @param {Array<{type,label,state}>} list
 */
export function buildPlotProposalMemoryBlock(list = []) {
  return buildProposalMemoryBlock(list,
    'BISHERIGE VORSCHLÄGE IN DIESEM GESPRÄCH (übernommene stehen schon im Board oben; verworfene nicht erneut vorschlagen, ausser der User bittet darum; offene nicht doppelt vorschlagen):',
    (l) => `«${l}»`);
}

/**
 * Prompt als zwei Blöcke:
 *   Block 1 (ttl '1h'): Rolle, Regeln, Werkzeug-Strategie, Buch-Kontext — über die
 *     Session stabil; der System-Prompt.
 *   Block 2 (preamble: true): Board-Outline samt Reihenfolge-Regel, Figurenliste,
 *     frühere Vorschläge und die Textpassagen zur Frage — ändert sich mit jeder
 *     Übernahme bzw. Frage. proposal-chat.js stellt ihn als Vorspann VOR die Frage
 *     in die User-Nachricht (wie den Erst-Kontext des Buch-Chats), damit Werkzeuge
 *     + System + Verlauf ein stabiler Cache-Präfix bleiben.
 *
 * @param {string} bookName
 * @param {object} ctx { mode ('agent'|'classic'), maxToolIter, toolNames,
 *                       bookContext, boardOutline, boardTrimmed, boardActs,
 *                       figurenOutline, proposalMemory, passages (classic immer;
 *                       agent als Erst-Kontext, null = ohne Embedding-Endpunkt),
 *                       passageStatus (Index-/Suchstand, chat-pre-context.js) }
 */
export function buildPlotChatSystemPrompt(bookName, ctx = {}) {
  const classic = ctx.mode === 'classic';
  const maxToolIter = Number(ctx.maxToolIter) || 8;
  const m = toolMentions(ctx.toolNames);
  const bookContext = String(ctx.bookContext || '').trim();
  const erzaehlweise = String(ctx.erzaehlweise || '').trim();

  const stable = [
    'Du bist Dramaturgin / Dramaturg und Plot-Coach für ein Buchprojekt. Du entwickelst mit dem Autor / der Autorin im Gespräch die Handlung auf dem Beat-Board der Plot-Werkstatt: Akte (Spalten), Beats (Handlungspunkte) und Handlungsstränge (Swimlanes, oft je Hauptfigur).',
    '',
    `Buch: «${bookName}»`,
    ...(erzaehlweise ? [erzaehlweise] : []),
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
      'ids nur aus dem Board im Vorspann der Frage — ein Vorschlag mit unbekannter id wird verworfen. Lass Felder weg, die du nicht setzen willst; ein leerer Wert heisst «nicht ändern». Ein Feld leeren (z.B. das Kapitel eines Beats entfernen) nur über `leeren`.',
    ] : [
      'Vorschlags-Werkzeuge (nichts wird gespeichert — der User übernimmt jeden Vorschlag einzeln):',
      '- `propose_beat` — neuer Beat (mit act_id bzw. act_ref) oder Änderung eines bestehenden (beat_id, nur geänderte Felder).',
      '- `propose_beat_move` — bestehenden Beat in anderen Akt/Strang/Platz verschieben.',
      '- `propose_act` — neuer Akt oder Umbenennung.',
      '- `propose_thread` — neuer Strang (optional mit Hauptfigur) oder Änderung.',
      'Ein Vorschlag pro Aufruf; mehrere Vorschläge = mehrere Aufrufe, gebündelt in einer Runde. Baust du etwas Neues auf (z.B. neue Aktstruktur mit Beats darin), schlage zuerst die Akte/Stränge vor und verweise in den Beats per act_ref/thread_ref auf deren `ref`.',
      'Meldet ein Vorschlags-Werkzeug einen Fehler (unbekannte id, falscher Akt, mehrdeutige Figur), korrigiere den Aufruf — rate keine ids, sie stehen im Board im Vorspann der Frage.',
      'Ein leerer Wert heisst «nicht ändern». Ein Feld leeren (z.B. das Kapitel eines Beats entfernen) nur über `leeren`.',
    ]),
    'Löschen kannst du nicht vorschlagen. Statt einen Beat zu löschen, schlage vor, ihn zu verwerfen (`propose_beat` mit beat_id und verworfen: true).',
    'Schlage nicht ungefragt das ganze Board um. Bei offenen Fragen („was meinst du?") antworte erst inhaltlich und biete Vorschläge an; bei klaren Aufträgen („mach mir drei Beats für …") schlage direkt vor.',
    '',
    'NIE GENERATIV IN DEN BUCHTEXT: Beats sind Struktur-Stichpunkte — Titel als prägnanter Handlungspunkt, Beschreibung als Stichpunkte (was passiert, welcher Konflikt, welche Wendung, was steht auf dem Spiel). Du schreibst keine Szenen, keine Dialoge, keine Romanprosa, auch nicht „als Beispiel".',
    '',
  ];
  if (classic) {
    stable.push(
      'Grundlage: das Board und die Figurenliste im Vorspann der Frage sowie die TEXTPASSAGEN (die semantisch nächsten Stellen des Manuskripts zur Frage, falls vorhanden). Was dort nicht steht, kennst du nicht — sage das, statt zu raten.',
      '',
      'ANTWORTFORMAT: ein JSON-Objekt {"antwort": "…", "vorschlaege": [ … ]}. `antwort` ist deine Antwort an den User (Markdown erlaubt), `vorschlaege` die Liste der Board-Vorschläge (leer, wenn keine). Sprache: die der Userfrage.',
      ...(bookContext ? ['', bookContext] : []),
    );
    return _finish(stable, ctx, { classic: true });
  }
  stable.push(
    'Lese-Werkzeuge:',
    `- Das aktuelle Board steht vor jeder Frage im Vorspann${m.has('get_plot_board') ? ' (`get_plot_board` brauchst du nur nach eigenen Rückfragen, z.B. für Strang-Erbschaften oder ein gekürztes Board)' : ''}.`,
    ...(m.has('search_similar') ? ['- Die TEXTPASSAGEN im Vorspann der Frage sind schon die semantisch nächsten Stellen zur aktuellen Frage — prüfe sie zuerst, bevor du liest.'] : []),
    ...m.route('Figuren, Beziehungen', ['list_figures', 'get_figure_profile', 'get_figure_relations']),
    ...m.route('Geplante Figuren mit psychologischem Kern (Want/Need/Wound/Lie, Bogen)', ['list_werkstatt_drafts']),
    ...m.route('Was schon geschrieben ist (Szenen, Ereignisse in Reihenfolge)', ['list_scenes', 'get_timeline']),
    ...m.route('Stellen im Text (nach Sinn bzw. Wortlaut)', ['search_similar', 'search_passages']),
    ...m.route('Ganze Kapitel lesen (teuer, nur wenn der Zusammenhang nötig ist)', ['get_chapter_text']),
    ...m.route('Weltregeln, gegen die ein Beat nicht verstossen darf', ['list_world_facts']),
    ...m.route('Themen & Motive', ['get_motifs']),
    ...m.route('Wie weit welche Kapitel sind (vom Autor gesetzter Bearbeitungsstand)', ['get_edit_status'], ' — ein neuer Beat in einem als fertig markierten Kapitel heisst Umbau: sag das dazu'),
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

// Vorspann-Block (Board, Reihenfolge-Regel, Figuren, Gedächtnis, Textpassagen zur
// Frage) und JSON-Pflicht des klassischen Pfads — gemeinsam für beide Modi.
function _finish(stable, ctx, { classic }) {
  const m = toolMentions(classic ? [] : ctx.toolNames);
  const volatile = [
    '=== AKTUELLES BEAT-BOARD (Stand dieser Frage; [#id] = id für die Vorschläge) ===',
    String(ctx.boardOutline || '').trim() || '(Board ist leer — noch keine Akte angelegt.)',
  ];
  if (Array.isArray(ctx.boardActs) && ctx.boardActs.length) volatile.push('', `REIHENFOLGE: ${_reihenfolgeRegel(ctx.boardActs)}`);
  if (ctx.boardTrimmed) {
    volatile.push('', `HINWEIS: Das Board ist für den Prompt gekürzt (Beschreibungen verkürzt, verworfene Beats nur gezählt).${m.has('get_plot_board') ? ' Vollständige Beats liefert `get_plot_board`.' : ' Frag den User, wenn dir ein Detail fehlt.'}`);
  }
  const fig = String(ctx.figurenOutline || '').trim();
  if (fig) volatile.push('', '=== FIGUREN (Name · fig_id bzw. draft#id = Kennung für figuren/figur) ===', fig);
  const mem = String(ctx.proposalMemory || '').trim();
  if (mem) volatile.push('', mem);
  // Textpassagen: klassisch immer (einzige Text-Grundierung), agentisch als
  // Erst-Kontext nur mit Embedding-Endpunkt (ctx.passages = Array).
  if (classic || Array.isArray(ctx.passages)) {
    volatile.push('', ...buildPassageBlockLines(ctx.passages, {
      classic, status: ctx.passageStatus, toolNames: ctx.toolNames,
      intro: '(Automatisch vorab geholt; Ausschnitte können unvollständig sein. Reichen sie, brauchst du kein Lese-Werkzeug.)',
      emptyClassic: '(keine — Embedding-Index fehlt oder kein Treffer; urteile über Board und Figuren)',
    }));
  }
  return [
    { text: stable.join('\n') + (classic ? _jsonOnly() : ''), ttl: '1h' },
    { text: volatile.join('\n'), preamble: true },
  ];
}

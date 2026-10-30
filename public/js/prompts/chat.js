// Seiten-Chat + Buch-Chat (klassisch + Agentic) Prompt-Builder.
// Liest SYSTEM_CHAT/SYSTEM_BOOK_CHAT live-bound aus core.js (von configurePrompts gesetzt).

import { _isLocal, JSON_ONLY } from './state.js';
import { buildEditStatusBlock } from './edit-status-block.js';
import { _obj, _str } from './schema-utils.js';
import { SYSTEM_CHAT, SYSTEM_BOOK_CHAT } from './core.js';
import { PAGE_CHAT_IDEEN_RULES, PAGE_CHAT_NACHRICHTEN_HINWEIS, buildBookTitlesBlock } from './page-chat.js';
import { CHAT_TOOLS, toolMentions } from './chat-tools/index.js';

/**
 * Figuren-Block der Chat-Prompts — gebudgetet.
 *
 * `getFiguren` (routes/jobs/shared/queries.js) liefert VOLLDOSSIERS: neben den
 * Stammdaten auch Lebensereignisse, Beziehungen, Schauplätze und Szenen jeder
 * Figur. Das ist die grösste unkontrollierte Grösse im Chat-Prompt — bei einem
 * ausanalysierten Buch mit über hundert Figuren sind das mehrere Hunderttausend
 * Zeichen. Ungekappt sprengt allein dieser Block das Kontextfenster, bevor eine
 * einzige Zeile Buchtext oder ein Werkzeug-Ergebnis im Prompt steht; der Call
 * scheitert dann am Preflight (lib/ai/shared.js#assertPromptFitsContext) — und
 * zwar bei JEDEM Provider, ein 200k-Fenster reicht dafür genauso wenig.
 *
 * Drei Stufen, in dieser Reihenfolge:
 *   'voll'    — die Dossiers passen ins Budget (kleines Ensemble: unverändert)
 *   'stamm'   — nur Stammdaten je Figur, die Detaillisten als ANZAHL
 *   'gekappt' — Stammdaten bis zum Budget, der Rest offengelegt
 *
 * GERATEN WIRD NICHTS: was der Block nicht trägt, wird als fehlend AUSGEWIESEN —
 * sonst hält das Modell ein gekapptes Ensemble für das ganze. `detailTools: true`
 * (agentischer Pfad) nennt die Werkzeuge, über die die Details einzeln nachzuladen
 * sind; ohne Werkzeuge bleibt es beim Hinweis.
 *
 * Reihenfolge ist die von `getFiguren` (figures.sort_order, Hauptfiguren zuerst) —
 * beim Kappen fällt damit das Nebenpersonal weg, nicht die Hauptfigur.
 *
 * @param {Array}  figuren  Ergebnis von getFiguren (kann leer/null sein)
 * @param {Object} opts     { maxChars, detailTools }
 * @returns {{ text, mode, shown, total, chars }|null}  null = kein Block
 */
export const FIGUREN_BLOCK_DEFAULT_MAX_CHARS = 40000;
const FIGUREN_DETAIL_KEYS = ['lebensereignisse', 'beziehungen', 'schauplätze', 'szenen'];
const FIGUREN_HEAD = '=== FIGUREN DES BUCHS ===';

function _figurStamm(f) {
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!FIGUREN_DETAIL_KEYS.includes(k)) out[k] = v;
  }
  const details = {};
  for (const k of FIGUREN_DETAIL_KEYS) {
    const n = Array.isArray(f[k]) ? f[k].length : 0;
    if (n > 0) details[k] = n;
  }
  if (Object.keys(details).length) out.weggelassen = details;
  return out;
}

export function buildFigurenBlock(figuren, opts = {}) {
  const list = Array.isArray(figuren) ? figuren.filter(Boolean) : [];
  if (!list.length) return null;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : FIGUREN_BLOCK_DEFAULT_MAX_CHARS;
  const m = toolMentions(opts.toolNames);
  const withTools = opts.detailTools === true && m.has('get_figure_profile');

  // Mit Detail-Werkzeugen (agentischer Buch-Chat) nie die Volldossiers: Szenen,
  // Schauplätze, Beziehungen und Lebensereignisse aller Figuren stünden sonst in
  // jeder Iteration im Prompt, obwohl eine Frage meist eine Figur betrifft — die
  // holt `get_figure_profile` gezielt.
  const voll = withTools ? null : JSON.stringify(list, null, 2);
  if (voll && voll.length <= maxChars) {
    const text = [FIGUREN_HEAD, voll].join('\n');
    return { text, mode: 'voll', shown: list.length, total: list.length, chars: text.length };
  }

  const hint = withTools
    ? `Details je Figur (Beziehungen, Szenen, Schauplätze, Lebensereignisse) über ${m.list(['get_figure_profile', 'get_figure_relations'], ' / ')} nachladen.`
    : 'Die Detaillisten je Figur sind hier nicht enthalten — schliesse aus ihrem Fehlen nichts.';
  const lead = [
    FIGUREN_HEAD,
    `(Stammdaten je Figur; \`weggelassen\` nennt die Anzahl der nicht enthaltenen Detaileinträge. ${hint})`,
  ];
  // Eine Figur pro Zeile: kein Pretty-Print-Aufschlag, aber lesbar — und zeilenweise
  // füllbar, weshalb das Kappen immer an einer Figurengrenze endet.
  const rows = list.map(f => JSON.stringify(_figurStamm(f)));
  const wrap = (head, body) => [...head, '[', body.join(',\n'), ']'].join('\n');

  const stamm = wrap(lead, rows);
  if (stamm.length <= maxChars) {
    return { text: stamm, mode: 'stamm', shown: list.length, total: list.length, chars: stamm.length };
  }

  const overhead = wrap([...lead, ''], []).length + 120;   // Kopf + Kappungs-Hinweis
  const shownRows = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.length + overhead > maxChars) break;
    shownRows.push(row);
    used += row.length + 2;
  }
  const rest = list.length - shownRows.length;
  const capped = [
    ...lead,
    `(NUR ${shownRows.length} von ${list.length} Figuren aufgeführt — ${rest} weitere fehlen in diesem Block. `
    + (withTools
      ? 'Frage nach einer hier fehlenden Figur gezielt via `get_figure_profile`.)'
      : 'Behandle die Liste NICHT als vollständiges Ensemble.)'),
  ];
  const text = wrap(capped, shownRows);
  return { text, mode: 'gekappt', shown: shownRows.length, total: list.length, chars: text.length };
}

/**
 * Welt-Fakten-Block des AGENTISCHEN Buch-Chats — gebudgetet, buch-stabil.
 *
 * Bewusst nur dort: der klassische Buch-Chat-Pfad füllt sein Textbudget mit
 * Buchtext-Passagen, und ein zweiter reservierter Block würde diese Rechnung
 * verschieben. Der Seiten-Chat arbeitet auf EINER Seite, für die die buchweiten
 * Weltregeln selten den Ausschlag geben.
 *
 * `world_facts` ist deklaratives Buch-Wissen aus der Komplettanalyse: etablierte
 * Weltregeln, Geografie, Daten, Technik, Kultur. Kurz, verdichtet, und damit die
 * billigste Antwort auf «welche Regel gilt hier», «was ist über X etabliert» —
 * Stufe 1 der Kosten-Leiter. Ohne den Block muss der Agent dieselbe Auskunft
 * über ein Werkzeug oder, schlimmer, über einen Kapitel-Volltext holen.
 *
 * Der Block gehört in den STABILEN, gecachten System-Anteil (nicht in den
 * Erst-Kontext): er hängt am Buch, nicht an der Frage. Im Erst-Kontext-Block
 * (`cache: false`) würde er jede Iteration neu bezahlt.
 *
 * ZWEI DINGE WERDEN NIE VERSCHWIEGEN:
 *  · Was der Deckel geschluckt hat, steht im Block (sonst hält das Modell eine
 *    gekappte Liste für den ganzen Kanon).
 *  · Ein NICHT erhobener Index liefert KEINEN Block (`scanned: false` → null) —
 *    ein leerer Block würde als «diese Welt hat keine Regeln» gelesen. Dass der
 *    Index fehlt, sagt dem Agenten das Werkzeug `list_world_facts`, wenn er fragt.
 *
 * Die Fakten stammen aus der KI-Extraktion, nicht von der Autorin — der Kopf
 * sagt das, damit das Modell sie nicht als kuratierten Kanon über den Buchtext
 * stellt.
 *
 * @param {{scanned:boolean, fakten:Array}|null} welt  Ausgabe von
 *        db/world-facts.js#listWorldFacts + #worldFactsScanState
 * @param {Object} opts { maxChars }
 * @returns {{ text, shown, total, chars }|null}  null = kein Block
 */
export const WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS = 8000;
const WELTFAKTEN_HEAD = '=== ETABLIERTE WELT-FAKTEN DES BUCHS ===';

// Rangfolge NUR fuer das Kappen, keine Taxonomie (die ist FAKT_KATEGORIE_WL in
// db/world-facts.js): die tragenden Weltgesetze stehen vorn, damit der Deckel
// zuerst das Beiwerk frisst und nicht die Regel, an der die Welt haengt.
function _weltKatRank(kategorie) {
  if (kategorie === 'regel' || kategorie === 'technik') return 0;
  if (kategorie === 'sonstiges') return 2;
  return 1;
}

export function buildWeltfaktenBlock(welt, opts = {}) {
  if (!welt || welt.scanned === false) return null;
  const list = (Array.isArray(welt.fakten) ? welt.fakten : []).filter(f => f && f.fakt);
  if (!list.length) return null;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS;

  const sorted = list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => _weltKatRank(a.f.kategorie) - _weltKatRank(b.f.kategorie) || a.i - b.i)
    .map(x => x.f);

  const rows = sorted.map(f => {
    const subj = f.subjekt ? `${f.subjekt}: ` : '';
    const kap = (f.kapitel || []).length ? ` (${f.kapitel.slice(0, 3).join(', ')})` : '';
    return `- [${f.kategorie || 'sonstiges'}] ${subj}${String(f.fakt).trim()}${kap}${f.widerlegt ? ' [real widerlegt]' : ''}`;
  });

  const lead = [
    WELTFAKTEN_HEAD,
    '(Aus der Komplettanalyse extrahiert, nicht von der Autorin kuratiert — im Zweifel gilt der Buchtext.',
    'Form: [kategorie] Subjekt: Aussage (Kapitel). Beantwortet die Frage schon hier, rufe direkt `final_answer`.)',
  ];
  if (sorted.some(f => f.widerlegt)) {
    lead.push('([real widerlegt] = der Faktencheck hat die Aussage per Quelle als real falsch belegt: sie steht so im Buch, ist aber keine reale Tatsache — nie als real bestätigen.)');
  }
  // Der Kappungs-Hinweis waechst mit den Zahlen darin, ein geschaetzter Overhead
  // reisst den Deckel deshalb gelegentlich. Darum EXAKT: rendern, und solange Zeilen
  // zurueckziehen, bis der fertige Block passt.
  const render = (shown) => {
    const rest = rows.length - shown.length;
    const parts = [...lead];
    if (rest > 0) {
      parts.push(`(NUR ${shown.length} von ${rows.length} Fakten aufgeführt — ${rest} weitere fehlen hier. `
        + (toolMentions(opts.toolNames).has('list_world_facts')
          ? 'Die Liste ist NICHT der vollständige Kanon; fehlt ein Fakt, frage `list_world_facts` mit kategorie/subjekt.)'
          : 'Die Liste ist NICHT der vollständige Kanon — schliesse aus dem Fehlen eines Fakts nichts.)'));
    }
    return [...parts, ...shown].join('\n');
  };
  // Grob vorfuellen (linear), damit ein Buch mit tausenden Fakten nicht tausendmal
  // gerendert wird; die Feinkorrektur unten braucht danach nur noch Einzelschritte.
  const estOverhead = lead.join('\n').length + 200;
  let fit = 0, used = 0;
  while (fit < rows.length && used + rows[fit].length + 1 + estOverhead <= maxChars) {
    used += rows[fit].length + 1;
    fit++;
  }
  let shown = rows.slice(0, Math.max(fit, 1));
  let text = render(shown);
  while (shown.length && text.length > maxChars) {
    shown = shown.slice(0, -1);
    text = render(shown);
  }
  if (!shown.length) return null;
  return { text, shown: shown.length, total: rows.length, chars: text.length };
}

/**
 * Baut den vollständigen System-Prompt für den Seiten-Chat.
 * @param {string}      pageName        Name der Seite
 * @param {string}      pageText        Aktueller Seiteninhalt als Plaintext
 * @param {Array}       figuren         Figuren-Array aus der DB (kann leer sein)
 * @param {Object}      review          Letzte Buchbewertung aus der DB (kann null sein)
 * @param {string|null} systemOverride  Optionaler System-Prompt-Override
 * @param {string|null} pageChangeNote  Änderungen seit Chat-Start als kompakter
 *                                      Wort-Diff (prompts/page-chat.js#formatPageChange);
 *                                      null = unverändert. Nie eine zweite Vollfassung.
 * @param {Array}       ideen           Offene Ideen des Autors für diese Seite +
 *                                      das umliegende Kapitel — Notizen zu möglichen
 *                                      Fortsetzungen, Szenen, Ankern. Jedes Item hat
 *                                      `scope: 'page'|'chapter'`. KI darf sie
 *                                      aufgreifen/diskutieren, aber nicht
 *                                      eigenmächtig in Vorschläge umwandeln.
 * @param {Object|null} lektorat        Letztes Lektorat dieser Seite aus page_checks
 *                                      ({ checked_at, fehler, szenen, stilanalyse, fazit }).
 *                                      Kann gegenüber pageText veraltet sein.
 * @param {Object}      opts            { figurenMaxChars } — Zeichenbudget des
 *                                      Figuren-Blocks (siehe buildFigurenBlock);
 *                                      { bookTitles, currentPageId } — Abschnittstitel
 *                                      des Buchs für Titelfragen (buildBookTitlesBlock).
 */
// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Figuren + Review) — ändert
//     sich weder über die Turns derselben Seite noch beim Seitenwechsel innerhalb
//     des Buchs. Der grosse SYSTEM_CHAT + die Figuren-JSON werden so über alle
//     Seiten-Chats eines Buchs aus dem Cache gelesen.
//   Block 2 (ttl '1h'): seiten-spezifischer Anteil (Seitenname/-inhalt + Ideen +
//     Lektorat + JSON-Format-Trailer) — stabil über die Turns einer Seiten-Session,
//     invalidiert beim Seitenwechsel oder wenn der Autor die Seite editiert. 1h statt
//     5 min, weil zwischen zwei Fragen oft mehr als fünf Minuten liegen (Lesen,
//     Überarbeiten); mit 5 min wurde Block 2 samt Verlauf fast jede Runde neu geschrieben.
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, pageChangeNote = null, ideen = null, lektorat = null, opts = {}) {
  const stable = [systemOverride ?? SYSTEM_CHAT];

  // Figuren des KAPITELS (der Aufrufer filtert), trotzdem gebudgetet: auch ein
  // Kapitel-Ensemble trägt Volldossiers. opts.figurenMaxChars kommt aus dem
  // Kontextfenster des effektiven Providers.
  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars });
  if (figBlock) stable.push('', figBlock.text);

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const titlesBlock = buildBookTitlesBlock(opts.bookTitles, opts.currentPageId ?? null);
  if (titlesBlock) stable.push('', titlesBlock);

  const page = [
    `Aktueller Abschnitt: «${pageName}»`,
    '',
  ];

  page.push('=== ABSCHNITTSINHALT ===', pageText, '');
  if (opts.hatNachrichten) page.push(PAGE_CHAT_NACHRICHTEN_HINWEIS, '');
  if (opts.editStatus) page.push(...buildEditStatusBlock(opts.editStatus));
  if (pageChangeNote) {
    page.push(
      '=== ÄNDERUNGEN DES AUTORS SEIT CHAT-START ([-entfernt-] {+eingefügt+}) ===',
      pageChangeNote,
      '',
      'Hinweis: Frühere Antworten und Vorschläge dieses Gesprächs beziehen sich teils auf den alten Stand. Beziehe dich auf den aktuellen Abschnittsinhalt oben; erwähne die Änderungen nur, wenn sie selbst Thema sind.',
      '',
    );
  }

  if (Array.isArray(ideen) && ideen.length > 0) {
    page.push('=== OFFENE IDEEN (Notizen des Autors für diesen Abschnitt + das umliegende Kapitel) ===');
    for (const i of ideen) {
      const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
      const tag = i.scope === 'chapter' ? '[Kapitel] ' : '[Abschnitt] ';
      page.push(`- ${tag}${i.content}${datum}`);
    }
    page.push('');
    page.push('Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. [Kapitel]-Notizen gelten fürs ganze Kapitel, [Abschnitt]-Notizen nur für diesen Abschnitt. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt.');
    page.push('');
  }

  const lekSzenen = Array.isArray(lektorat?.szenen) ? lektorat.szenen : [];
  if (lektorat && ((Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0) || lekSzenen.length > 0 || lektorat.stilanalyse || lektorat.fazit)) {
    const datum = lektorat.checked_at ? lektorat.checked_at.slice(0, 16).replace('T', ' ') : null;
    page.push(`=== LETZTES LEKTORAT DIESES ABSCHNITTS${datum ? ` (Stand ${datum})` : ''} ===`);
    page.push(JSON.stringify({
      ...(Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0 ? { fehler: lektorat.fehler } : {}),
      ...(lekSzenen.length > 0 ? { szenen: lekSzenen } : {}),
      ...(lektorat.stilanalyse ? { stilanalyse: lektorat.stilanalyse } : {}),
      ...(lektorat.fazit ? { fazit: lektorat.fazit } : {}),
    }, null, 2));
    page.push('');
    page.push('Hinweis: Diese Beanstandungen stammen aus einem früheren Lektoratslauf. Der Abschnittstext kann seitdem überarbeitet worden sein — prüfe gegen den aktuellen Abschnittsinhalt, bevor du dich darauf beziehst. Wiederhole bereits erledigte Punkte nicht; greife noch offene Beanstandungen auf, wenn der Autor danach fragt oder daran arbeitet.');
    page.push('');
  }

  page.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)",',
    '  "vorschlaege": [',
    '    {',
    '      "original": "exakter Originaltext aus dem Abschnitt (zeichengenau)",',
    '      "ersatz": "Ersatztext",',
    '      "begruendung": "kurze Begründung"',
    '    }',
    '  ],',
    '  "titel_varianten": ["Titelvariante"],',
    '  "ideen": [{ "inhalt": "Pendenz als knapper Stichpunkt", "begruendung": "kurz: was du bemerkt hast", "ort": "abschnitt" }]',
    '}',
    '',
    'VORSCHLÄGE-REGELN:',
    '- Wenn du stilistische, inhaltliche oder sprachliche Schwächen erkennst oder der Autor nach Verbesserungen fragt: liefere mindestens einen konkreten Vorschlag mit original und ersatz.',
    '- original muss zeichengenau mit dem Abschnittstext übereinstimmen und darin genau einmal vorkommen (sonst etwas mehr Kontext mitnehmen).',
    '- original liegt innerhalb EINES Absatzes (Absätze sind im Abschnittsinhalt durch Leerzeilen getrennt): über eine Absatzgrenze hinweg lässt sich nichts ersetzen — betrifft eine Änderung mehrere Absätze, liefere je Absatz einen eigenen Vorschlag.',
    '- ersatz muss den Stil des Autors beibehalten.',
    '- vorschlaege ist nur dann ein leeres Array, wenn die Frage rein inhaltlich/konzeptionell ist und keine Textstelle betrifft (z.B. Plotfragen, Figurenmotivation).',
    '- titel_varianten nur, wenn der Autor nach einem Titel, einer Überschrift oder Headline fragt: dann 3 bis 5 kurze, unterschiedliche Varianten (nur der Titel, ohne Anführungszeichen oder Nummerierung). Sonst ein leeres Array.',
    '',
    ...PAGE_CHAT_IDEEN_RULES,
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: page.join('\n'), ttl: '1h' },
  ];
}

/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
// Synthese-Aufforderung für den Fall, dass die Werkzeug-Iterationen erschöpft
// sind, ohne dass das Modell final_answer gerufen hat. Statt mit einem Fehler
// aufzugeben, verlangt diese Nachricht die Antwort aus dem bereits Gesammelten. Die
// Werkzeugliste bleibt dabei unverändert (Prompt-Cache, routes/jobs/agentic-chat/
// loop.js) — darum sagt die Anweisung selbst, dass nur noch final_answer zählt.
export const BOOK_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Recherche-Iterationen erreicht — keine weitere Recherche mehr möglich. '
  + 'Fasse JETZT aus den bereits gesammelten Informationen die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Rufe kein anderes Werkzeug mehr auf als `final_answer` — weitere Aufrufe werden nicht ausgeführt. '
  + 'Wenn die Recherche unvollständig blieb, beantworte die Frage so weit wie möglich mit dem Vorhandenen und weise kurz darauf hin, was nicht abgedeckt werden konnte. '
  + 'Sprache der Antwort: die der Userfrage.';

// Synthese-Aufforderung, wenn der Kosten-Deckel pro Antwort
// (`jobs.book_chat.max_input_tokens_per_answer`) erreicht ist — Gegenstück zu
// BOOK_CHAT_FORCE_FINAL_INSTRUCTION (Iterationsdeckel), gleicher Ablauf.
export const BOOK_CHAT_BUDGET_FINAL_INSTRUCTION =
  'Das Recherche-Budget für diese Antwort ist aufgebraucht — keine weitere Recherche mehr möglich. '
  + 'Fasse JETZT aus den bereits gesammelten Informationen die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Rufe kein anderes Werkzeug mehr auf als `final_answer` — weitere Aufrufe werden nicht ausgeführt. '
  + 'Wenn die Recherche unvollständig blieb, beantworte die Frage so weit wie möglich und nenne kurz, was offen blieb. '
  + 'Sprache der Antwort: die der Userfrage.';

// Rückgabe: Array mit EINEM System-Cache-Block (ttl '1h'): der über die Session
//   stabile Anteil (System, Werkzeug-Strategie, Figuren, Welt-Fakten, Review,
//   final_answer-Pflicht). Tools + dieser Block + der bisherige Verlauf sind der
//   Cache-Präfix jeder Iteration und jedes Turns. Der Erst-Kontext (semantisch
//   nächste Passagen zur AKTUELLEN Frage, buildBookChatPreContext) gehört NICHT
//   hierher: er trägt pro Frage andere Bytes und steht darum vor der Frage in
//   deren User-Nachricht (routes/jobs/chat/book-chat-agent.js, `userPreamble`).
export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null, maxToolIter = 6, opts = {}) {
  // opts.semantic === false: der Embedding-Endpunkt fehlt, `search_similar` wird dem
  // Modell gar nicht angeboten (Filter in routes/jobs/chat/book-chat.js#prepare) — dann
  // darf der Prompt es auch nicht empfehlen, sonst verbrennt das Modell eine Runde an
  // einem Werkzeug, das es nicht hat.
  const semantic = opts.semantic !== false;
  // opts.toolNames: die TATSÄCHLICH angebotenen Werkzeuge (Slim-Satz, fehlender
  // Endpunkt, keine Daten im Buch). Was nicht angeboten wird, darf der Prompt nicht
  // nennen — jede Werkzeug-Erwähnung geht durch toolMentions. Ohne Angabe: alles.
  const m = toolMentions(semantic
    ? opts.toolNames
    : (opts.toolNames || CHAT_TOOLS.map(t => t.name)).filter(n => n !== 'search_similar'));
  const stage2 = m.list(['search_similar', 'search_passages', 'get_figure_profile', 'get_figure_mentions', 'get_timeline', 'quote_passage']);
  const stage3 = m.list(['get_pages', 'get_chapter_text']);
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    ...(opts.erzaehlweise ? [opts.erzaehlweise] : []),
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    ...m.route('Häufigkeit, Verteilung, Erzählperspektive', ['get_stil_metrics']),
    ...m.route('Aufbau, Reihenfolge, was steht vor/nach X, in welchem Teil/Unterkapitel (Gliederung in Lesereihenfolge)', ['list_chapters']),
    ...m.route('Figurenverteilung, erstes und letztes Auftreten', ['get_figure_mentions']),
    ...m.route('Konkrete Textstellen oder Zitate', ['search_passages', 'quote_passage']),
    ...m.route('Stellen nach SINN oder Eigenschaft (Stilmittel, Stimmung, Motiv, Umschreibung)', ['search_similar']),
    ...m.route('Ganze Kapitel lesen', ['get_chapter_text']),
    ...m.route('Wer ist X, wer kennt wen', ['get_figure_profile', 'get_figure_relations']),
    ...m.route('Lektorat: Übersicht (view=hotspots), dann Einzelbefunde (view=findings)', ['get_lektorat']),
    ...m.route('Kapitel-Qualität, Stärken/Schwächen', ['get_reviews']),
    ...m.route('Wie weit ist das Buch/Kapitel, was ist noch Rohfassung, was wurde seit «fertig» wieder angefasst, woran als Nächstes arbeiten', ['get_edit_status'], ' (Selbsteinschätzung des Autors, kein Qualitätsurteil)'),
    ...m.route('Geplante Handlung / Beat-Board / was noch nicht geschrieben ist', ['get_plot_board']),
    ...m.route('Geplante Themen & Motive, Soll/Ist-Abgleich (welche Motive fehlen im Text), Fundstellen eines Motivs', ['get_motifs']),
    ...m.route('Recherche-Material des Autors (gesammelte Fakten, Zitate, Quellen; was zu einem Kapitel gehört, was noch nicht eingearbeitet ist; stimmt der Text mit dem Gesammelten überein?)', ['list_research_items', 'read_research_item', 'search_research_passages']),
    '',
    'Rufe Werkzeuge an, bevor du vermutest.',
    'KOSTEN-LEITER — nimm die billigste Quelle, die die Frage beantwortet, und HÖRE DANN AUF:',
    '  Stufe 1 (gratis, schon da): der ERST-KONTEXT direkt vor der aktuellen Frage (in derselben Nachricht; semantisch nächste Passagen zu ihr) plus die Blöcke FIGUREN, WELT-FAKTEN und BUCHBEWERTUNG. Beantwortet das die Frage, rufst du SOFORT `final_answer` — ohne ein einziges Recherche-Werkzeug.',
    ...(stage2 ? [`  Stufe 2 (billig, gezielt): ${stage2}. Diese liefern Passagen, keine Volltexte.`] : []),
    ...(stage3 ? [`  Stufe 3 (teuer, Volltext): ${stage3}. Nur wenn die Frage den ZUSAMMENHANG längerer Passagen braucht — Zusammenfassen, Aufbau/Dramaturgie eines Kapitels, Auswahl über den ganzen Text.`] : []),
    'Schmale Faktenfragen — Alter, Datum, Beruf, Wohnort, Verwandtschaft, «wann hat X …», «wie heisst Y» — werden auf Stufe 1 oder 2 beantwortet. Lade dafür NIE ein ganzes Kapitel und nie das ganze Buch: ein einzelner Fakt steht in einer Passage, nicht in einem Kapitel.',
    ...m.ifAll(['search_passages'], 'STRATEGIE — Suche vs. Lektüre: `search_passages` ist Stichwort-Suche („wo kommt das bekannte Wort/der Name X vor?"). Stellen nach einer EIGENSCHAFT oder Bedeutung haben KEINE Stichwort-Signatur — rate dann NICHT mit search_passages nach Wörtern.'
      + (m.has('search_similar')
        ? ' Beispiele für ein Stilmittel, eine Stimmung, ein Motiv, „Stellen über X" in eigenen Worten → ZUERST `search_similar` mit grossem `snippet_chars` (1200–1500); die Ausschnitte sind meist schon die Belege.'
        : '')),
    ...m.ifAll(['get_chapter_text', 'list_chapters'], 'Musst du über den GANZEN Text auswählen oder vollständig sein (lustigste/schönste/spannendste Stelle, ALLE Stellen zu X, Zusammenfassung, Ton des Buchs), lies den Text selbst: lade ganze Kapitel via `get_chapter_text` (mehrere gebündelt in einer Runde) und wähle aus eigener Lektüre aus. Bei kleinen/mittleren Büchern, die in den Kontext passen (siehe `hint` aus list_chapters), lade gleich das ganze Buch statt es in vielen Runden zu durchforsten. Das gilt NUR für Aufgaben, die den ganzen Text sichten müssen. Dass ein Buch in den Kontext passt, ist kein Grund, es für eine einzelne Faktenfrage zu laden.'),
    ...m.ifAll(['quote_passage'], 'Wörtliche Zitate: IMMER über quote_passage holen (pattern → Stelle, oder offset+length aus einem Treffer), NIE aus Erinnerung paraphrasieren. Beim final_answer-Call jedes wörtliche Zitat in `zitate` mitliefern — Server validiert.'),
    `Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, NICHT ein Tool-Call). Halte Werkzeug-Argumente präzise und kurz. Die Iterationen sind knapp — verschwende sie nicht mit seriellem Stichwort-Raten, wenn wenige gebündelte Volltext-Aufrufe den ganzen relevanten Text in einer Runde liefern.`,
    'WICHTIG — bündle Werkzeuge: Rufe in EINER Runde alle Werkzeuge parallel auf, die nicht voneinander abhängen, statt eines nach dem anderen. Bei breiten Aufgaben (z.B. „Zitate/Stellen aus vielen Kapiteln") gleich mehrere Such- oder Lese-Aufrufe gleichzeitig absetzen. Erst danach in der nächsten Runde zitieren/auswerten. So reichen die Iterationen auch für umfangreiche Recherchen.',
    '',
  ];

  // Werkzeuge sind hier der Ausweg aus dem Budget: was der Block nicht trägt, holt
  // das Modell bei Bedarf gezielt via get_figure_profile / get_figure_relations.
  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars, detailTools: true, toolNames: opts.toolNames });
  if (figBlock) {
    parts.push(figBlock.text);
    parts.push('');
  }

  // Welt-Fakten: buch-stabil, darum hier im gecachten Block 1 und NICHT im
  // Erst-Kontext (der wechselt pro Frage und wird jede Iteration neu bezahlt).
  const weltBlock = buildWeltfaktenBlock(opts.welt, { maxChars: opts.weltfaktenMaxChars, toolNames: opts.toolNames });
  if (weltBlock) {
    parts.push(weltBlock.text);
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Liefere deine finale Antwort IMMER über das Werkzeug `final_answer` (Pflicht-Endpunkt). Kein Freitext-Output ohne Tool-Call — auch wenn keine Recherche-Tools nötig sind, muss die Antwort via final_answer kommen. Sprache der Antwort: passe dich der Sprache der Userfrage an, nicht der Sprache dieses Prompts.',
  );

  // Werkzeug-Disziplin für lokale/kleinere Modelle. Nicht Stil, sondern die drei
  // Fehler, die den Loop dort tatsächlich zerlegen: erfundene Werkzeugnamen,
  // Aufrufe als Text statt als Tool-Call, und Werkzeug-Schleifen ohne Abschluss.
  if (_isLocal) {
    parts.push(
      '',
      'WERKZEUG-DISZIPLIN (verbindlich):',
      '- Rufe NUR Werkzeuge aus der bereitgestellten Liste. Ein Werkzeug, das dort nicht steht, existiert nicht — erfinde keine Namen und keine Parameter.',
      '- Rufe Werkzeuge über den Werkzeug-Mechanismus, NIE indem du den Aufruf als Text oder JSON in die Antwort schreibst.',
      '- Argumente als gültiges JSON, nur die dokumentierten Felder.',
      '- Höre auf zu recherchieren, sobald du antworten kannst, und rufe dann `final_answer`. Wiederhole keinen Aufruf, der schon ein Ergebnis geliefert hat.',
      '- Steht die Antwort schon im ERST-KONTEXT, rufe sofort `final_answer` — ohne ein einziges Recherche-Werkzeug.',
    );
  }

  return [{ text: parts.join('\n'), ttl: '1h' }];
}

// Erst-Kontext-Block (vor der Frage in deren User-Nachricht): ./chat-pre-context.js.
export { buildBookChatPreContext } from './chat-pre-context.js';

// Werkzeuge des agentischen Buch-Chats: Lese-Werkzeuge aus dem gemeinsamen
// Katalog (./chat-tools/), Ausgabe in ./book-chat-output.js. Übersicht: docs/chat-tools.md.


// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Buchname + Figuren +
//     Review) — ändert sich über die Turns einer Session nicht. Der potenziell
//     grosse Figuren-/Review-Kontext wird so über alle Turns aus dem Cache gelesen.
//   Block 2 (cache:false): die pro Query neu keyword-selektierten Buchseiten +
//     JSON-Format-Trailer. Bewusst OHNE Breakpoint, weil der Block jede Runde
//     andere Seiten trägt — ein Breakpoint wäre ein cache_write ohne je gelesen
//     zu werden. Steht am Ende, damit Block 1 ein stabiler Präfix bleibt.
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null, opts = {}) {
  const stable = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
  ];

  // Gliederung (opts.gliederung, fertiger Text aus buildGliederungBlock): buch-stabil,
  // darum im gecachten Block 1 — sie ordnet die Auszüge aus Block 2 im Buch ein.
  if (opts.gliederung) stable.push('', opts.gliederung);

  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars });
  if (figBlock) stable.push('', figBlock.text);

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const volatil = [];
  if (relevantPages && relevantPages.length > 0) {
    // excerpt=true: die Textstellen sind semantisch retrievte Chunk-Auszüge (Mini-RAG),
    // nicht ganze Seiten — das Modell darf daraus nicht auf Vollständigkeit der Seite schliessen.
    const excerpt = opts.excerpt === true;
    // Reihenfolge = Lesereihenfolge (der Job sortiert nach der Gliederung); der
    // Kapitelpfad sagt, wo der Abschnitt im Buch steht.
    if (excerpt) {
      volatil.push('=== RELEVANTE TEXTSTELLEN AUS DEM BUCH ===');
      volatil.push('(Bedeutungs-relevanteste Auszüge, in Lesereihenfolge; können unvollständig sein. Was dazwischen steht, fehlt.)');
    } else {
      volatil.push('=== RELEVANTE ABSCHNITTE AUS DEM BUCH ===');
      volatil.push('(In Lesereihenfolge; eine Auswahl, nicht das ganze Buch.)');
    }
    for (const page of relevantPages) {
      const where = page.chapter_path ? ` (Kapitel: ${page.chapter_path})` : '';
      volatil.push(excerpt ? `--- Auszug aus Abschnitt: ${page.name}${where} ---` : `--- Abschnitt: ${page.name}${where} ---`);
      volatil.push(page.text);
      volatil.push('');
    }
  }

  volatil.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: volatil.join('\n'), cache: false },
  ];
}

// ── Chat-Titel ────────────────────────────────────────────────────────────────

/**
 * System-Prompt für die KI-Zusammenfassung eines Chat-Verlaufs zu einem kurzen
 * History-Titel. Genutzt von allen drei Chats (Seiten-/Buch-/Recherche-Chat) über
 * routes/jobs/chat-title.js. Bewusst knapp — der Titel steht in einer schmalen
 * History-Liste, nicht als ganzer Satz.
 */
export function buildChatTitlePrompt() {
  const parts = [
    'Du erstellst einen sehr kurzen, prägnanten Titel für einen Chat-Verlauf.',
    'Fasse das Thema der folgenden Konversation in maximal 6 Wörtern zusammen.',
    'Regeln:',
    '- Verwende dieselbe Sprache wie die Konversation.',
    '- Beschreibe das Thema; wiederhole nicht wörtlich die ganze Frage.',
    '- Kein Schlusspunkt, keine Anführungszeichen, keine Emojis, keine Aufzählung.',
    '',
    'Antworte ausschliesslich als JSON-Objekt: {"titel": "…"}',
  ];
  if (!_isLocal) parts.push('', JSON_ONLY);
  return parts.join('\n');
}

export const SCHEMA_CHAT_TITLE = _obj({ titel: _str });

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });

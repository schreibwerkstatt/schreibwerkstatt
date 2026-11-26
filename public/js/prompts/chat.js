// Seiten-Chat + Buch-Chat (klassisch + Agentic) Prompt-Builder.
// Liest SYSTEM_CHAT/SYSTEM_BOOK_CHAT live-bound aus core.js (von configurePrompts gesetzt).

import { _isLocal, JSON_ONLY } from './state.js';
import { buildPageChatWeltLines } from './blocks-welt.js';
import { buildEditStatusBlock } from './edit-status-block.js';
import { _obj, _str } from './schema-utils.js';
import { SYSTEM_CHAT, SYSTEM_BOOK_CHAT } from './core.js';
import { PAGE_CHAT_IDEEN_RULES, pageChatIdeenLines, pageChatFigurenHead, pageChatFigurenNachtrag, pageChatIdeenAenderungRules, pageChatNachrichtenHinweis, buildBookTitlesBlock, buildCurrentTitleLine } from './page-chat.js';
import { CHAT_TOOLS, toolMentions } from './chat-tools/index.js';
import { buildWeltfaktenBlock } from './weltfakten-block.js';
import { roundNoteRule } from './chat-round-note.js';
import { formatAbschnitt } from './book-text-format.js';
import { buildPageChatZeitstrahlLines, buildPageChatKontinuitaetLines, buildPageChatBuchIdeenLines, buildPageChatSzenenLines } from './page-chat-kontext.js';
export { buildWeltfaktenBlock, WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS } from './weltfakten-block.js';

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
 * @param {Object} opts     { maxChars, detailTools, compact, dropLists }
 *   compact   — Volldossiers eine Figur pro Zeile statt eingerückt (gleicher Inhalt,
 *               ~20 % kleiner; Abschnitts-Chat-Modus `kompakt`)
 *   dropLists — Detaillisten, die im Volldossier fehlen sollen (Abschnitts-Chat-Modus
 *               `ohne_listen`: ['szenen', 'schauplätze']); ihre Anzahl steht als
 *               `weggelassen` an der Figur, wie im Stammdaten-Modus
 * @returns {{ text, mode, shown, total, chars }|null}  null = kein Block
 */
export const FIGUREN_BLOCK_DEFAULT_MAX_CHARS = 40000;
const FIGUREN_DETAIL_KEYS = ['lebensereignisse', 'beziehungen', 'schauplätze', 'szenen'];
const FIGUREN_HEAD = '=== FIGUREN DES BUCHS ===';

function _figurStamm(f, keys = FIGUREN_DETAIL_KEYS) {
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!keys.includes(k)) out[k] = v;
  }
  const details = {};
  for (const k of keys) {
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
  // opts.head: Kopfzeile(n) statt `=== FIGUREN DES BUCHS ===` — der Abschnitts-Chat
  // sagt so, ob der Block nur das Kapitel oder das ganze Buch trägt.
  const head = Array.isArray(opts.head) && opts.head.length ? opts.head.join('\n') : FIGUREN_HEAD;
  const dropLists = Array.isArray(opts.dropLists) ? opts.dropLists.filter(k => FIGUREN_DETAIL_KEYS.includes(k)) : [];
  const wrap = (lines, body) => [...lines, '[', body.join(',\n'), ']'].join('\n');

  // Mit Detail-Werkzeugen (agentischer Buch-Chat) nie die Volldossiers: Szenen,
  // Schauplätze, Beziehungen und Lebensereignisse aller Figuren stünden sonst in
  // jeder Iteration im Prompt, obwohl eine Frage meist eine Figur betrifft — die
  // holt `get_figure_profile` gezielt.
  if (!withTools) {
    const listsNote = dropLists.length
      ? [`(Volldossiers ohne die Listen ${dropLists.map(k => `\`${k}\``).join(' und ')}; \`weggelassen\` nennt deren Anzahl. Schliesse aus ihrem Fehlen nichts.)`]
      : [];
    const text = dropLists.length
      ? wrap([head, ...listsNote], list.map(f => JSON.stringify(_figurStamm(f, dropLists))))
      : opts.compact
        ? wrap([head], list.map(f => JSON.stringify(f)))
        : [head, JSON.stringify(list, null, 2)].join('\n');
    if (text.length - head.length - 1 <= maxChars) {
      const mode = dropLists.length ? 'ohne_listen' : opts.compact ? 'kompakt' : 'voll';
      return { text, mode, shown: list.length, total: list.length, chars: text.length };
    }
  }

  const hint = withTools
    ? `Details je Figur (Beziehungen, Szenen, Schauplätze, Lebensereignisse) über ${m.list(['get_figure_profile', 'get_figure_relations'], ' / ')} nachladen.`
    : 'Die Detaillisten je Figur sind hier nicht enthalten — schliesse aus ihrem Fehlen nichts.';
  const lead = [
    head,
    `(Stammdaten je Figur; \`weggelassen\` nennt die Anzahl der nicht enthaltenen Detaileinträge. ${hint})`,
  ];
  // Eine Figur pro Zeile: kein Pretty-Print-Aufschlag, aber lesbar — und zeilenweise
  // füllbar, weshalb das Kappen immer an einer Figurengrenze endet.
  const rows = list.map(f => JSON.stringify(_figurStamm(f)));

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
 *                                      Mit `id`/`status` als [#id] gelistet —
 *                                      Ziel von `ideen_aenderungen`
 *                                      (opts.ideenStages = aktive Stufen).
 * @param {Object|null} lektorat        Letztes Lektorat dieser Seite aus page_checks
 *                                      ({ checked_at, fehler, szenen, stilanalyse, fazit }).
 *                                      Kann gegenüber pageText veraltet sein.
 * @param {Object}      opts            { figurenMaxChars } — Zeichenbudget des
 *                                      Figuren-Blocks (siehe buildFigurenBlock);
 *                                      { bookTitles, currentPageId } — Abschnittstitel
 *                                      des Buchs für Titelfragen (buildBookTitlesBlock);
 *                                      { figurenScope } — Kopf des Figuren-Blocks
 *                                      (prompts/page-chat.js#pageChatFigurenHead);
 *                                      { abschnittFiguren } — Stammzeilen der Figuren,
 *                                      die der Abschnitt nennt, aber Block 1 nicht trägt
 *                                      (Block 2, routes/jobs/chat/page-chat-figuren.js).
 */
// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): kapitel-stabiler Anteil (System + Figuren des Kapitels +
//     Review + Titelliste ohne Markierung + Zeitstrahl des Buchs + Kontinuitäts-
//     Befunde des Kapitels) — ändert sich weder über die Turns derselben Seite noch
//     beim Wechsel zu einem anderen Abschnitt desselben Kapitels und wird über
//     Sessions hinweg gelesen. Nichts Abschnitts-Spezifisches hier hinein (auch keine
//     Markierung des aktuellen Abschnitts) — das gehört in Block 2.
//   Block 2 (5 min): seiten-spezifischer Anteil (Seitenname, Stellung in der
//     Titelliste, Seiteninhalt, Ideen des Abschnitts + des übrigen Buchs, Lektorat,
//     JSON-Format-Trailer) — ändert sich mit jedem übernommenen Vorschlag und jeder
//     übernommenen Idee. Auf Prod hatten 19 von 26 Gesprächen eine einzige Frage, und
//     in rund der Hälfte der Folgerunden war der Abschnitt geändert: der 1h-Write (2×)
//     wurde meist nie gelesen, 5 min (1,25×) ist in jedem Fall billiger.
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, pageChangeNote = null, ideen = null, lektorat = null, opts = {}) {
  const stable = [systemOverride ?? SYSTEM_CHAT];
  // opts.sizes (optional, Out-Parameter): Zeichen je Baustein fürs Job-Log —
  // welcher Teil den Prompt trägt, ohne die Rückgabeform zu ändern.
  const sizes = opts.sizes && typeof opts.sizes === 'object' ? opts.sizes : {};
  sizes.system = String(stable[0] ?? '').length;

  // Figuren des KAPITELS (der Aufrufer filtert), trotzdem gebudgetet: auch ein
  // Kapitel-Ensemble trägt Volldossiers. opts.figurenMaxChars kommt aus dem
  // Kontextfenster des effektiven Providers.
  // opts.figurenModus (Setting jobs.page_chat.figuren_modus):
  //   voll        — Volldossiers aller Kapitelfiguren, eingerückt
  //   kompakt     — derselbe Inhalt, eine Figur pro Zeile
  //   ohne_listen — kompakt, ohne die Szenen- und Schauplatz-Listen (Anzahl bleibt)
  const figurenModus = opts.figurenModus || 'voll';
  const figBlock = buildFigurenBlock(figuren, {
    head: pageChatFigurenHead(opts.figurenScope),
    maxChars: opts.figurenMaxChars,
    compact: figurenModus !== 'voll',
    dropLists: figurenModus === 'ohne_listen' ? ['szenen', 'schauplätze'] : [],
  });
  if (figBlock) stable.push('', figBlock.text);
  sizes.figuren = figBlock ? figBlock.chars : 0;
  sizes.figurenModus = figBlock ? `${figBlock.mode} ${figBlock.shown}/${figBlock.total}` : '-';

  sizes.review = 0;
  if (review) {
    const reviewJson = JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2);
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', reviewJson);
    sizes.review = reviewJson.length;
  }

  // Ohne Markierung des aktuellen Abschnitts: Block 1 bleibt für alle Abschnitte
  // gleich (Cache über Seitenwechsel); die Stellung steht in Block 2.
  const titlesBlock = buildBookTitlesBlock(opts.bookTitles);
  if (titlesBlock) stable.push('', titlesBlock);
  sizes.titel = titlesBlock ? titlesBlock.length : 0;

  // Zeitstrahl des Buchs + offene Kontinuitäts-Befunde dieses Kapitels: beide hängen
  // nur am Buch bzw. Kapitel, gehören also in den kapitel-stabilen Block 1.
  // opts.kontextMaxChars: Deckel je Block aus dem Kontextfenster des Providers.
  const caps = opts.kontextMaxChars || {};
  const zeitLines = buildPageChatZeitstrahlLines(opts.zeitstrahl, { maxChars: caps.zeitstrahl });
  if (zeitLines.length) stable.push('', ...zeitLines);
  sizes.zeitstrahl = zeitLines.join('\n').length;
  const kontLines = buildPageChatKontinuitaetLines(opts.kontinuitaet, { maxChars: caps.kontinuitaet });
  if (kontLines.length) stable.push('', ...kontLines);
  sizes.kontinuitaet = kontLines.join('\n').length;

  const titleLine = buildCurrentTitleLine(opts.bookTitles, opts.currentPageId ?? null);
  const page = [
    `Aktueller Abschnitt: «${pageName}»`,
    ...(titleLine ? [titleLine] : []),
    '',
  ];

  // Der aktuelle Abschnitt als Tag (Format: ./book-text-format.js). `aktuell="ja"`
  // trennt ihn von den Kontext-Passagen anderer Abschnitte (buildPageChatBookContext),
  // die dasselbe Tag tragen — `original` darf nur aus diesem kommen.
  page.push(formatAbschnitt({ title: pageName || '', text: pageText || '' }, { aktuell: 'ja' }), '');
  sizes.abschnitt = String(pageText || '').length;
  sizes.aenderungen = pageChangeNote ? pageChangeNote.length : 0;
  if (opts.hatNachrichten) page.push(pageChatNachrichtenHinweis(opts.langCode), '');
  if (opts.editStatus) page.push(...buildEditStatusBlock(opts.editStatus));
  if (pageChangeNote) {
    page.push(
      '=== ÄNDERUNGEN DES AUTORS SEIT CHAT-START ([-entfernt-] {+eingefügt+}) ===',
      pageChangeNote,
      '',
      'Hinweis: Frühere Antworten und Vorschläge dieses Gesprächs beziehen sich teils auf den alten Stand. Beziehe dich auf den aktuellen Abschnitt oben (<abschnitt aktuell="ja">); erwähne die Änderungen nur, wenn sie selbst Thema sind.',
      '',
    );
  }

  // Figuren, die der Abschnitt nennt, die Block 1 aber nicht trägt (veraltete
  // Kapitel-Zuordnung): nur Stammzeile — wer, wo im Buch. Hier und nicht in Block 1,
  // weil die Auswahl am Abschnittstext hängt (Block 1 ist kapitel-stabil).
  const abschnittFigLines = pageChatFigurenNachtrag(opts.abschnittFiguren, 'abschnitt');
  page.push(...abschnittFigLines);
  sizes.figurenAbschnitt = abschnittFigLines.join('\n').length;

  const hatIdeen = Array.isArray(ideen) && ideen.length > 0;
  const ideenLines = pageChatIdeenLines(ideen);
  page.push(...ideenLines);
  sizes.ideen = ideenLines.join('\n').length;
  // Offene Ideen im übrigen Buch, gruppiert nach Lage zu DIESEM Abschnitt → Block 2.
  const buchIdeenLines = buildPageChatBuchIdeenLines(opts.buchIdeen, { maxChars: caps.ideen });
  page.push(...buchIdeenLines);
  sizes.buchIdeen = buchIdeenLines.join('\n').length;
  // Frühere Szenen mit Figuren, die dieser Abschnitt nennt → Block 2 (hängt am Text).
  const szenenLines = buildPageChatSzenenLines(opts.szenen, { maxChars: caps.szenen });
  page.push(...szenenLines);
  sizes.szenen = szenenLines.join('\n').length;

  const weltLines = buildPageChatWeltLines(opts.weltfakten, opts.soziolekte);
  page.push(...weltLines);
  sizes.welt = weltLines.join('\n').length;
  sizes.lektorat = 0;
  const lekSzenen = Array.isArray(lektorat?.szenen) ? lektorat.szenen : [];
  if (lektorat && ((Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0) || lekSzenen.length > 0 || lektorat.stilanalyse || lektorat.fazit)) {
    const datum = lektorat.checked_at ? lektorat.checked_at.slice(0, 16).replace('T', ' ') : null;
    page.push(`=== LETZTES LEKTORAT DIESES ABSCHNITTS${datum ? ` (Stand ${datum})` : ''} ===`);
    const lektoratJson = JSON.stringify({
      ...(Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0 ? { fehler: lektorat.fehler } : {}),
      ...(lekSzenen.length > 0 ? { szenen: lekSzenen } : {}),
      ...(lektorat.stilanalyse ? { stilanalyse: lektorat.stilanalyse } : {}),
      ...(lektorat.fazit ? { fazit: lektorat.fazit } : {}),
    }, null, 2);
    page.push(lektoratJson);
    sizes.lektorat = lektoratJson.length;
    page.push('');
    page.push('Hinweis: Diese Beanstandungen stammen aus einem früheren Lektoratslauf. Der Abschnittstext kann seitdem überarbeitet worden sein — prüfe gegen den aktuellen Abschnitt (<abschnitt aktuell="ja">), bevor du dich darauf beziehst. Wiederhole bereits erledigte Punkte nicht; greife noch offene Beanstandungen auf, wenn der Autor danach fragt oder daran arbeitet.');
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
    '      "begruendung": "kurze Begründung",',
    '      "typ": "korrektur" | "stil"',
    '    }',
    '  ],',
    '  "titel_varianten": ["Titelvariante"],',
    '  "ideen": [{ "inhalt": "Pendenz als knapper Stichpunkt", "begruendung": "kurz: was du bemerkt hast", "ort": "abschnitt" }],',
    '  "ideen_aenderungen": [{ "idee_id": 12, "inhalt": "", "status": "erledigt", "beleg": "wörtliche Textstelle aus dem Abschnitt", "begruendung": "kurz: warum" }]',
    '}',
    '',
    'VORSCHLÄGE-REGELN:',
    '- Vorschläge und Ideen stehen in den Feldern vorschlaege/ideen/ideen_aenderungen. Wiederhole sie nicht im Antworttext: kein Vorschlags- oder Ideen-Block, keine Statusliste in antwort — die App zeigt deine Vorschläge unter der Antwort an.',
    '- Wenn du stilistische, inhaltliche oder sprachliche Schwächen erkennst oder der Autor nach Verbesserungen fragt: liefere mindestens einen konkreten Vorschlag mit original und ersatz.',
    '- original stammt ausschliesslich aus dem aktuellen Abschnitt (<abschnitt aktuell="ja">), muss zeichengenau mit dessen Text übereinstimmen und darin genau einmal vorkommen (sonst etwas mehr Kontext mitnehmen).',
    '- original liegt innerhalb eines Absatzes (Absätze sind im Abschnittstext durch Leerzeilen getrennt): über eine Absatzgrenze hinweg lässt sich nichts ersetzen — betrifft eine Änderung mehrere Absätze, liefere je Absatz einen eigenen Vorschlag.',
    '- ersatz muss den Stil des Autors beibehalten.',
    '- ersatz ist Fliesstext ohne Markdown. Einzige Ausnahme: *kursiv* bzw. **fett**, wo die Stelle Hervorhebung braucht (z.B. Gedanken, die im Buch kursiv stehen) — das wird beim Übernehmen echte Auszeichnung.',
    '- Soll ein Absatz geteilt werden, steht im ersatz an der Teilungsstelle eine Leerzeile (im JSON: \\n\\n). Sonst keine Zeilenumbrüche im ersatz. Absätze zusammenlegen geht nicht.',
    '- typ: "korrektur" für Fehler (Rechtschreibung, Grammatik, Zeichensetzung, Logik-, Fakten- oder Anschlussfehler), "stil" für alles, was nur besser klingen soll.',
    '- Höchstens 8 Vorschläge, die wichtigsten zuerst. Gäbe es mehr, sag in antwort, dass du auf Nachfrage weitere lieferst.',
    '- vorschlaege ist nur dann ein leeres Array, wenn die Frage rein inhaltlich/konzeptionell ist und keine Textstelle betrifft (z.B. Plotfragen, Figurenmotivation).',
    '- titel_varianten nur, wenn der Autor nach einem Titel, einer Überschrift oder Headline fragt: dann 3 bis 5 kurze, unterschiedliche Varianten (nur der Titel, ohne Anführungszeichen oder Nummerierung). Sonst ein leeres Array.',
    '',
    ...PAGE_CHAT_IDEEN_RULES,
    '',
    ...pageChatIdeenAenderungRules(hatIdeen ? opts.ideenStages : null, { hatIdeen }),
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  // TTL je Haltbarkeit: Block 1 trägt nur Buch-/Kapitelstoff und wird über Sessions
  // und Abschnitte desselben Kapitels gelesen → 1h. Block 2 und der Verlauf ändern
  // sich mit jedem übernommenen Vorschlag und meist sind es Gespräche mit einer
  // Frage → 5 min (Schreiben 1,25× statt 2×). Längere TTL immer vor kürzerer.
  const blocks = [
    { text: stable.join('\n'), ttl: '1h' },
    { text: page.join('\n') },
  ];
  sizes.block1 = blocks[0].text.length;
  sizes.block2 = blocks[1].text.length;
  return blocks;
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
  // Gegenregel zu Stufe 1: «schon da» heisst, die Stelle STEHT im Startkontext — nicht,
  // dass das Modell ohne sie antworten darf. Sonst schreibt es «ich kenne die Szene
  // nicht» und rät, obwohl ein Suchaufruf sie geliefert hätte.
  const findTools = m.list(['search_passages', 'search_similar'], ' oder ');
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
    ...(findTools ? [`  Stufe 1 reicht NICHT, sobald die Frage eine Szene, Situation, Stelle oder Handlung im Buch nennt («er observiert gerade …», «die Szene, in der …», «als X Y trifft»), die du im Startkontext nicht wörtlich vor dir hast: dann suchst du sie zuerst (${findTools}) und liest sie, bevor du antwortest — auch bei Ideen- und Schreibfragen, die auf dieser Stelle aufbauen. Antworte nie mit «die Szene kenne ich nicht» oder bedingten Vorschlägen, ohne gesucht zu haben; erst wenn die Suche nichts findet, sag das.`] : []),
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
    ...roundNoteRule(),
    'ZITATE UND BELEGE: Das System zeigt die geprüften Belege unter deiner Antwort an. Gib sie deshalb nicht in die Antwort aus — kein «Belege»- oder «Quellen»-Abschnitt am Fuss, keine Zitatliste, keine Beleg-Nummern im Fliesstext. Wörtliche Zitate gehören in das Feld `zitate` von `final_answer`.',
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
    // Abschnitte als Tags (Format: ./book-text-format.js); `auszug="ja"` = nur ein Ausschnitt.
    for (const page of relevantPages) {
      volatil.push(formatAbschnitt({ title: page.name, text: page.text }, {
        kapitel: page.chapter_path || null,
        auszug: excerpt ? 'ja' : null,
      }));
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

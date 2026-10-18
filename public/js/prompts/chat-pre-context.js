// Erst-Kontext-Bausteine der Chats: die semantisch nächsten Stellen zur aktuellen
// Frage (routes/jobs/chat/book-chat-retrieval.js#preContextPassages) als Prompt-Text.
// Geteilt von Buch-Chat (agentisch, buildBookChatPreContext), Plot-Chat und
// Ideen-Chat (Textpassagen-Block) — gleiche Passagen-Kopfzeile, gleicher Status-
// Hinweis. Steht nie im gecachten System-Block: er trägt pro Frage andere Bytes.

/**
 * Kopfzeile einer Passage: Art, Titel, Sprungziel (`entity_id`, bei Abschnitten =
 * page_id), Kapitelpfad und eine STABILE Relevanzangabe — Rang (1 = bester) und
 * roher Cosinus. Der stufenabhängige Pipeline-Score (RRF ~0.03, Rerank, Cosinus)
 * geht bewusst nicht ans Modell: als RRF-Wert sähe jeder Treffer irrelevant aus.
 * @param {{kind:string,entity_id:number,title?:string,chapter_path?:string,rank?:number,similarity?:number}} p
 */
export function passageHeader(p) {
  const meta = [`entity_id ${p.entity_id}`];
  if (p.chapter_path) meta.push(`Kapitel: ${p.chapter_path}`);
  if (Number.isInteger(p.rank)) meta.push(`Rang ${p.rank}`);
  if (Number.isFinite(p.similarity)) meta.push(`Ähnlichkeit ${p.similarity}`);
  return `--- ${p.kind}: «${p.title || ''}» (${meta.join(', ')}) ---`;
}

/** Lesehilfe zur Relevanzangabe der Kopfzeilen (einmal pro Block). */
export const PASSAGE_RELEVANCE_NOTE =
  'Rang = Reihenfolge der Suche (1 = bester Treffer); Ähnlichkeit = Kosinus 0–1, nur relativ zwischen den Treffern zu lesen.';

/**
 * Hinweis zum Stand der Bedeutungssuche, damit das Modell «keine/zu wenige
 * Treffer» richtig liest. `status` (book-chat-retrieval.js#preContextStatus):
 *   disabled        — kein Embedding-Endpunkt
 *   error           — Suche ausgefallen (Backend-Fehler)
 *   indexIncomplete — Index deckt nur einen Teil des Buchs ab; `stalePages` > 0 =
 *                     so viele Abschnitte seit dem letzten Indexlauf neu/geändert
 * `tools`: der Chat hat Lese-Werkzeuge (Hinweis nennt den Ausweg) — der klassische
 * Pfad hat keine. '' = nichts zu sagen (vollständiger Index).
 */
export function passageStatusNote(status, { tools = true } = {}) {
  const st = status || {};
  const fallback = tools
    ? ' Prüfe mit search_passages (Wortlaut) oder get_chapter_text.'
    : ' Urteile nur über das, was dir vorliegt, und sage dazu, dass der Text nicht vollständig durchsucht wurde.';
  if (st.disabled) return `(Keine Bedeutungssuche konfiguriert — es gibt keine vorab geholten Stellen.${tools ? ' Arbeite über die Lese-Werkzeuge.' : ''})`;
  if (st.error) return `(Die Bedeutungssuche ist für diese Frage ausgefallen — über den Buchtext sagt das NICHTS aus.${fallback})`;
  if (st.indexIncomplete) {
    const why = st.stalePages > 0
      ? `${st.stalePages} Abschnitt(e) sind seit dem letzten Indexlauf neu oder geändert und fehlen hier ganz oder in neuer Fassung`
      : 'der Bedeutungs-Index dieses Buchs ist unvollständig (Indexlauf fehlt oder brach ab)';
    return `(ACHTUNG: ${why}. Was hier fehlt, kann trotzdem im Buch stehen — schliesse NIE aus fehlenden Treffern, dass etwas nicht vorkommt.${fallback})`;
  }
  return '';
}

/**
 * Erst-Kontext-Block des agentischen Buch-Chats: die semantisch nächsten Passagen
 * zur aktuellen Frage, vorab geholt über dieselbe Pipeline wie `search_similar`.
 * Steht als eigener Textblock vor der Frage in deren User-Nachricht (nicht im
 * System-Prompt — dort bräche er den Cache-Präfix).
 * `passages` = [{ kind, entity_id, title, chapter_path?, rank, similarity?, text }]
 * oder leer/null; `status` siehe passageStatusNote.
 *
 * Ohne Treffer bleibt der Block mit Begründung stehen — unvollständiger Index,
 * ausgefallene Suche und «wirklich nichts gefunden» sind drei verschiedene
 * Aussagen; ohne Block deutete das Modell das Fehlen als «kein Index» und
 * überspränge gleich auf die Volltext-Werkzeuge.
 */
export function buildBookChatPreContext(passages, status = null) {
  const list = Array.isArray(passages) ? passages : [];
  const head = ['=== ERST-KONTEXT: SEMANTISCH NÄCHSTE STELLEN ZUR AKTUELLEN FRAGE ==='];
  const note = passageStatusNote(status);
  if (!list.length) {
    head.push(note || '(Keine Treffer bei vollständigem Index — die Frage ist vermutlich nicht textbezogen, oder das Buch sagt es mit anderen Worten. Weiter auf Stufe 2 der Kosten-Leiter.)');
    return head.join('\n');
  }
  head.push(
    '(Automatisch vorab geholt, dieselbe Pipeline wie `search_similar`; nach Relevanz sortiert, Ausschnitte können unvollständig sein.',
    'Beantworten diese Stellen die Frage, antworte direkt via `final_answer` — kein weiteres Werkzeug. Sonst arbeite von hier aus weiter:',
    '`entity_id` eines Abschnitts (kind page) geht als page_id in `get_pages`/`quote_match`. Wörtliche Zitate IMMER über quote_match/quote_passage verifizieren, nie aus diesem Ausschnitt abschreiben.',
    `${PASSAGE_RELEVANCE_NOTE})`,
  );
  if (note) head.push(note);
  for (const p of list) head.push(passageHeader(p), p.text, '');
  return head.join('\n');
}

/**
 * Textpassagen-Block des Plot- und Ideen-Chats (beide Pfade). `classic` = ohne
 * Lese-Werkzeuge; `intro`/`emptyClassic` sind die chat-eigenen Sätze (z.B. Ideen-Chat:
 * «für einen Erledigt-Check lies den Abschnitt selbst»).
 * @returns {string[]} Zeilen für den ungecachten Block
 */
export function buildPassageBlockLines(passages, { classic, status = null, intro = '', emptyClassic = '' } = {}) {
  const list = Array.isArray(passages) ? passages : [];
  const lines = ['=== TEXTPASSAGEN (semantisch nächste Stellen zur Frage) ==='];
  const note = passageStatusNote(status, { tools: !classic });
  if (list.length) {
    if (!classic && intro) lines.push(intro);
    lines.push(classic
      ? `(${PASSAGE_RELEVANCE_NOTE})`
      : `(\`entity_id\` eines Abschnitts (kind page) = page_id für \`get_pages\`. ${PASSAGE_RELEVANCE_NOTE})`);
    if (note) lines.push(note);
    for (const p of list) lines.push(passageHeader(p), String(p.text || '').trim());
  } else {
    lines.push(note || (classic ? emptyClassic : '(keine Treffer zur Frage — nutze bei Bedarf die Lese-Werkzeuge)'));
  }
  return lines;
}

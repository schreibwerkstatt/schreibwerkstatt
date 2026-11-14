'use strict';

// HTML→Plain-Text Normalisierung fuer page_stats / search / page_revisions.
// SSoT fuer Server-Pfade; Frontend-Pendant in public/js/html-text.js MUSS
// dieselbe Logik tragen (siehe CLAUDE.md „HTML→Text-Normalisierung fuer Stats:
// Frontend MUSS Server matchen").
//
// Reihenfolge: Tags zu Single-Space → HTML-Entities dekodieren → \s+ collapsen
// → trim. Entity-Decode ist Pflicht, sonst zaehlt z.B. `&#160;` (trailing NBSP
// aus Editor-Cursor-Anker) als 6 Zeichen rein, waehrend DOMParser-basierte
// Konsumenten (Revision-Diff) 1 NBSP → kollabiertes Whitespace sehen → Stats
// driften gegen sichtbaren Text.

const { NAMED_ENTITIES } = require('./html-entities');
const { msgNameSides } = require('./msg-lines');

function _decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const n = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10FFFF) return m;
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    // Entity-Namen sind case-sensitiv (`&Uuml;` ≠ `&uuml;`) — kein Lowercasing.
    const cp = Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : undefined;
    return cp !== undefined ? String.fromCodePoint(cp) : m;
  });
}

// Diagramm-Bloecke fallen VOR dem Tag-Strip komplett raus. Ihr Inhalt ist
// Quelltext einer Diagrammsprache, kein Prosatext: `flowchart TD` und
// `A[Ausgangslage] --> B` wuerden sonst als Woerter zaehlen, in die Satzlaengen
// der Stil-Metriken eingehen, im Wortschatz als Lieblingswoerter auftauchen und
// im Volltextindex Treffer erzeugen. Die Aussage des Diagramms steht im Bild,
// nicht in seiner Notation.
//
// Regex statt DOM-Parse, weil dieses Modul bewusst parserfrei ist (es laeuft im
// Browser wie im Server, ohne linkedom). Selektor-Aequivalent zu
// public/js/diagram/mermaid-html.js#DIAGRAM_SEL, gegated durch
// tests/unit/mermaid-drift.test.mjs.
const _DIAGRAM_BLOCK_RE = /<pre\b[^>]*\bclass\s*=\s*("[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*')[^>]*>[\s\S]*?<\/pre>/gi;

/** Diagramm-Bloecke aus HTML entfernen (Block → ein Space).
 *
 *  Eigener Export, weil es einen zweiten HTML→Text-Pfad gibt, der NICHT dieser
 *  Normalisierung folgen kann: die Prompt-Variante in
 *  routes/jobs/shared/ai.js#htmlToTextForPrompt haelt Absatzgrenzen als `\n\n`
 *  (Dialogformat-Regel). Sie braucht denselben Ausschnitt, aber nicht denselben
 *  Rest — darum liegt der Ausschnitt hier als Einzelschritt und nicht nur
 *  eingebacken in htmlToPlainText. */
function stripDiagramBlocks(html) {
  return String(html || '').replace(_DIAGRAM_BLOCK_RE, ' ');
}

// Tags → Wortgrenze (Space), aber kein Space an einem Satzzeichen. Fuer den
// KI-Pfad (routes/jobs/shared/ai.js, beide `htmlToText`-Varianten).
//
// Der blinde Tag→Space ersetzte jede Tag-Grenze durch ein Leerzeichen, auch
// dort, wo der Editor keines rendert: aus `… <a>Asianometry</a>.` wurde im
// Prompt-Text `Asianometry .`, aus `</a>,` wurde `» ,`. Das Lektorat meldete
// beides als Grammatikfehler („Vor dem Satzschlusspunkt steht kein
// Leerzeichen") und schlug eine Korrektur vor, die im Text nichts zu tun hatte —
// ein Phantom-Befund je Link, dem ein Satzzeichen folgt.
//
// Zwei Klassen Zeichen binden sich nach links (Punkt, Komma, …, schliessende
// Klammer, schliessendes Anfuehrungszeichen) bzw. nach rechts (oeffnende
// Klammer, «, „): an ihnen darf eine INLINE-Tag-Grenze kein Space sein.
// Zwischen zwei Wortzeichen bleibt sie Space — das ist die harmlosere Annahme.
//
// Block-Tags (`_BLOCK_TAG`: Absatz, Listenpunkt, Ueberschrift, Zelle, `<br>` …)
// sind IMMER Space, auch in einem Lauf mit Inline-Tags: der Editor rendert an
// ihnen einen Umbruch. Die Zeichen-Klassen sind nicht eindeutig genug, um eine
// Absatzgrenze zu tragen — `“`/`‘` schliessen im Deutschen, oeffnen aber im
// Englischen, `»` oeffnet in der »…«-Schreibweise, und `…` kann einen Absatz
// beginnen. Ohne die Block-Regel kleben `ging.</p><p>»Hallo«` zu `ging.»Hallo«`
// und `said</p><p>“Hello”` zu `said“Hello”`.
//
// Nur TAGS werden betrachtet: ein wirklich getipptes Leerzeichen vor einem
// Komma steht danach weiterhin im Prompt-Text und bleibt damit ein echter
// Befund.
//
// Warum nicht in `htmlToPlainText` eingebackt: die Zaehl-Normalisierung muss
// mit dem Frontend bit-identisch bleiben (CLAUDE.md „HTML→Text-Normalisierung
// fuer Stats: Frontend MUSS Server matchen"), und das Frontend hat keinen
// Prompt-Pfad — eine Kopie dort haette keinen Konsumenten und nur
// Drift-Potenzial.
//
// Zwilling: public/js/utils/text-match.js#tagGapIsSpace (Fundstellen-View).
// Die Kopie ist noetig, weil dieser Pfad synchron ist und die ESM-Bridge nicht;
// Zeichen-Klassen und Block-Liste sind gegen Drift gegated
// (tests/unit/lektorat-html-prompt.test.mjs).
const _TAG_MARK = '\u0000';
const _BLOCK_MARK = '\u0001';
// Zeichen, die sich nach LINKS binden: davor erzeugt eine Tag-Grenze kein Space.
const _NO_SPACE_BEFORE_TAG = /[.,;:!?%…»›“”‘’)\]}]/;
// Zeichen, die sich nach RECHTS binden: dahinter ebenfalls kein Space.
const _NO_SPACE_AFTER_TAG = /[([{«‹„‚]/;
// Tags, an denen der Editor umbricht — dort ist die Grenze immer Space.
const _BLOCK_TAG = /^<\/?(?:p|div|li|ul|ol|dl|dt|dd|h[1-6]|blockquote|pre|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|section|article|aside|header|footer|nav|br|hr)(?=[\s/>])/i;

// Fuer das Drift-Gate gegen den Browser-Zwilling.
const TAG_GAP_CLASSES = { bindsLeft: _NO_SPACE_BEFORE_TAG, bindsRight: _NO_SPACE_AFTER_TAG, blockTag: _BLOCK_TAG };

/** HTML → Text, in dem jede Tag-Grenze eine Wortgrenze ist — ausser an
 *  Satzzeichen neben einem Inline-Tag, wo der Editor keinen Leerraum rendert.
 *  Siehe den Kommentar ueber den Zeichen-Klassen. */
function stripTagsKeepPunctuation(html) {
  const marked = String(html || '').replace(/<[^>]+>/g, t => (_BLOCK_TAG.test(t) ? _BLOCK_MARK : _TAG_MARK));
  if (!marked.includes(_TAG_MARK)) return marked.replace(/\u0001/g, ' ');
  const isMark = c => c === _TAG_MARK || c === _BLOCK_MARK;
  return marked.replace(/[\u0000\u0001]/g, (m, i) => {
    if (m === _BLOCK_MARK) return ' ';
    // Nachbarzeichen ueber einen Lauf benachbarter Tags hinweg suchen: der
    // Lauf entscheidet einstimmig, sonst entstuende zwischen zwei Tags ein
    // Space, den die Nachbarn nicht wollen. Ein Block-Tag im Lauf trennt.
    let a = i - 1;
    while (a >= 0 && isMark(marked[a])) { if (marked[a] === _BLOCK_MARK) return ' '; a--; }
    let b = i + 1;
    while (b < marked.length && isMark(marked[b])) { if (marked[b] === _BLOCK_MARK) return ' '; b++; }
    const prev = a >= 0 ? marked[a] : '';
    const next = b < marked.length ? marked[b] : '';
    // Ein vorhandenes Whitespace trennt ohnehin — dann bleibt es beim Space.
    if (prev && next && !/\s/.test(prev) && !/\s/.test(next)
      && (_NO_SPACE_AFTER_TAG.test(prev) || _NO_SPACE_BEFORE_TAG.test(next))) return '';
    return ' ';
  });
}

// Tabellen-Bloecke. ANDERS ALS DIAGRAMME sind sie NICHT generell ausgeschnitten
// — ihr Inhalt ist Text des Autors und zaehlt in `page_stats.chars/words`, steht
// im Volltextindex und im Revisions-Diff. Wer eine Tabelle schreibt, hat
// geschrieben.
//
// Ausgeschnitten wird nur fuer die Masse, die ueber SAETZE definiert sind:
//   - Wortschatz-Analyse (lib/lexicon/analyze.js): MATTR, MTLD, Yule K und die
//     Lieblingswoerter. Eine Spalte mit 40 Jahreszahlen ist kein Vokabular; sie
//     treibt die Hapax-Quote und liefert „2023" als Lieblingswort.
//   - Stil-Metriken (lib/page-index.js via routes/sync.js): Satzlaengen,
//     Satzanfaenge, Flesch/LIX. Eine Zelle ist kein Satz — „1.2 Mio" waere ein
//     Satz aus zwei Woertern ohne Verb und zieht den Rhythmus-Befund nach unten.
//
// Selektor-Aequivalent zu public/js/table/table-html.js#TABLE_SEL, gegated durch
// tests/unit/table-drift.test.mjs. Verschachtelte Tabellen gibt es nicht (der
// Markup-Vertrag erlaubt in einer Zelle nur Inline-Inhalt), darum genuegt der
// nicht-greedy Match.
const _TABLE_BLOCK_RE = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;

/** Tabellen aus HTML entfernen (Block → ein Space). Parity-Pendant zu
 *  public/js/html-text.js#stripTableBlocks. */
function stripTableBlocks(html) {
  return String(html || '').replace(_TABLE_BLOCK_RE, ' ');
}

// Zeilen/Spalten und Kopfzeile einer Tabelle aus ihrem Markup — parserfrei, wie
// der Rest des Moduls.
function _tableShape(tableHtml) {
  const rows = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) || [];
  let cols = 0;
  for (const r of rows) cols = Math.max(cols, (r.match(/<t[dh]\b/gi) || []).length);
  const headRow = rows.find(r => /<th\b/i.test(r)) || '';
  const head = (headRow.match(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi) || [])
    .map(c => _decodeEntities(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { rows: rows.length, cols, head };
}

/** Tabellen fuer den KI-Prompt zu einer Kurzform verdichten.
 *
 *  Warum nicht der Volltext: eine Datentabelle kostet Prompt-Tokens in einer
 *  Groessenordnung, zu der das Lektorat nichts zu sagen hat — es prueft Prosa,
 *  und eine Zahlenkolonne hat keinen Stil, keine Wiederholung und kein
 *  Show-vs-Tell. Warum nicht ganz weg (wie beim Diagramm): das Modell soll
 *  wissen, DASS hier eine Tabelle steht — sonst meldet es den Absatz davor als
 *  abgebrochen und den Bezug „wie die folgende Tabelle zeigt" als unbelegt.
 *
 *  Der Kopf bleibt drin: er ist die Aussage der Tabelle in einer Zeile und
 *  taugt fuer Begriffskonsistenz-Befunde. */
function summarizeTableBlocks(html, { label = 'Tabelle' } = {}) {
  return String(html || '').replace(_TABLE_BLOCK_RE, (m) => {
    const { rows, cols, head } = _tableShape(m);
    const dims = cols > 0 && rows > 0 ? `${rows}×${cols}` : '';
    const cap = (m.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i) || [])[1];
    const capText = cap ? _decodeEntities(cap.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
    const bits = [label, dims].filter(Boolean).join(' ');
    const tail = [capText, head.length ? `Kopf: ${head.join(' | ')}` : ''].filter(Boolean).join(' — ');
    return `\n\n[${tail ? `${bits}: ${tail}` : bits}]\n\n`;
  });
}

/** Nachrichtenverlauf (div.msg-thread, Markup-SSoT public/js/messages/msg-html.js)
 *  fuer KI-Prompts markieren: eine Start- und eine Endmarke als eigene Absaetze,
 *  die Nachrichten selbst bleiben unveraendert.
 *
 *  Warum Marken: SMS-/Chat-Sprache („gleich, 5 min", Kleinschreibung,
 *  fehlende Satzzeichen) ist Figurenrede, kein Fehler — ohne den Hinweis
 *  „korrigiert" das Lektorat sie und meldet die kurzen Zeilen als abgehackt.
 *  Warum die Nachrichten unangetastet: Lektorat-Befunde werden ueber ihren
 *  Originaltext im Seiten-HTML wiedergefunden; ein Praefix vor jeder Nachricht
 *  („→ …") landete im zitierten Original und der Befund faende nichts mehr. */
// Oeffnender Tag eines Verlaufs: `class` mit doppelten, einfachen oder ohne
// Anfuehrungszeichen, weitere Klassen erlaubt, `msg-thread` als ganzes Wort.
const _MSG_THREAD_OPEN_RE = /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*(?<![\w-])msg-thread(?![\w-])[^"]*"|'[^']*(?<![\w-])msg-thread(?![\w-])[^']*'|msg-thread(?![\w-]))[^>]*>/gi;
const _DIV_TAG_RE = /<div\b[^>]*>|<\/div\s*>/gi;

/** Alle Verlaeufe im HTML: `[{ start, end, innerStart, innerEnd }]`.
 *  Das Ende zaehlt verschachtelte `<div>` mit — ein inneres `<div>` (Paste aus
 *  einer fremden App, aelterer Stand vor dem Aufraeumen beim Speichern) beendet
 *  den Verlauf nicht. Ein Verlauf ohne schliessendes `</div>` zaehlt nicht. */
function findMsgThreads(html) {
  const s = String(html || '');
  const out = [];
  const open = new RegExp(_MSG_THREAD_OPEN_RE.source, 'gi');
  let m;
  while ((m = open.exec(s))) {
    const innerStart = m.index + m[0].length;
    const tags = new RegExp(_DIV_TAG_RE.source, 'gi');
    tags.lastIndex = innerStart;
    let depth = 1;
    let t;
    while ((t = tags.exec(s))) {
      if (t[0][1] === '/') { if (--depth === 0) break; } else if (!/\/\s*>$/.test(t[0])) depth++;
    }
    if (!t) continue;
    out.push({ start: m.index, end: t.index + t[0].length, innerStart, innerEnd: t.index });
    open.lastIndex = t.index + t[0].length;
  }
  return out;
}

/** Jeden Verlauf durch `fn(thread, inner, openTag, closeTag)` ersetzen (wie
 *  `String#replace` mit `(match, inner)`), Ende verschachtelungsfest
 *  (findMsgThreads). */
function replaceMsgThreads(html, fn) {
  const s = String(html || '');
  let out = '';
  let last = 0;
  for (const th of findMsgThreads(s)) {
    out += s.slice(last, th.start) + fn(s.slice(th.start, th.end), s.slice(th.innerStart, th.innerEnd),
      s.slice(th.start, th.innerStart), s.slice(th.innerEnd, th.end));
    last = th.end;
  }
  return out + s.slice(last);
}

// Marken in der Sprache des Prompts — der Lektorat-Prompt ist pro Buchsprache
// gebaut, und sein Regelblock (public/js/prompts/blocks.js#_buildNachrichtenBlock)
// zitiert genau diese Wortlaute. Unbekannte Sprache faellt auf Deutsch.
const MSG_THREAD_MARKS = {
  de: { label: 'Nachrichtenverlauf (SMS/Chat, Schreibweise der Figuren)', end: 'Ende Nachrichtenverlauf' },
  en: { label: 'Message thread (text/chat, the characters\' own spelling)', end: 'End of message thread' },
};

// `rows: true` (Komplettanalyse): jede Zeile traegt ihre Art im Text, in der
// Konvention des TXT-Exports (lib/export-builders/txt.js) — Absender mit
// Doppelpunkt, Zeit/Datum/Chatname in eckigen Klammern, ausgehend mit «→».
// Die Startmarke erklaert die Zeichen selbst, damit jeder Pass sie versteht,
// ohne dass jeder System-Prompt einen Regelblock braucht. Why: die Richtung
// steht sonst nur in der Klasse und faellt beim Tag-Strip weg — in einem
// Zweier-Chat ohne Namenszeilen weiss das Modell nicht, wer was schreibt, und
// ordnet Aussagen der falschen Figur zu; eine nackte Uhrzeitzeile liest es als
// Erzaehldatum. Nicht fuers Lektorat: dort landete das Praefix im Zitat (oben).
const MSG_THREAD_ROW_LABELS = {
  de: 'Nachrichtenverlauf (SMS/Chat der Figuren, eine Zeile pro Nachricht; «→» = gesendet vom Handy, aus dessen Sicht der Verlauf gezeigt wird, meist die Perspektivfigur; ohne Pfeil = empfangen; «Name:» = Absender der folgenden Nachrichten auf seiner Seite (steht der Name über «→»-Zeilen, gehört ihm das Handy); [ … ] = Uhrzeit, Datum oder Chatname, keine Nachricht)',
  en: 'Message thread (the characters\' text/chat, one line per message; «→» = sent from the phone the thread is shown from, usually the point-of-view character; no arrow = received; «Name:» = sender of the following messages on that side (a name above «→» lines is the phone\'s owner); [ … ] = time, date or chat name, not a message)',
};

function _msgRowsToText(inner) {
  return inner.replace(_MSG_LINE_RE, (_p, attrs, body) => {
    if (!htmlToPlainText(body)) return '';
    const kind = _msgLineKind(attrs);
    if (kind === 'name') return `<p>${body}:</p>`;
    if (kind === 'meta') return `<p>[${body}]</p>`;
    return kind === 'out' ? `<p>→ ${body}</p>` : `<p>${body}</p>`;
  });
}

// `marks: false` (Embedding-Index): Verlauf ohne Marken, die Nachrichten als
// gewoehnliche Absaetze — eine Marke in jedem Chunk mit Verlauf zoege dessen
// Vektor zum Begriff «Nachrichtenverlauf» statt zum Inhalt.
function markMsgThreads(html, { langCode = 'de', rows = false, marks = true } = {}) {
  if (!marks) return String(html || '');
  const lc = MSG_THREAD_MARKS[langCode] ? langCode : 'de';
  const { end } = MSG_THREAD_MARKS[lc];
  const label = rows ? MSG_THREAD_ROW_LABELS[lc] : MSG_THREAD_MARKS[lc].label;
  return replaceMsgThreads(html,
    (_m, inner) => `<p>[${label}]</p>${rows ? _msgRowsToText(inner) : inner}<p>[${end}]</p>`);
}

function hasMsgThread(html) {
  return findMsgThreads(html).length > 0;
}

function htmlToPlainText(html) {
  return _decodeEntities(stripDiagramBlocks(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const _MSG_LINE_RE = /<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi;
// Zeilenart aus der Klasse; ohne Zeilenklasse eingehend (wie im Editor).
const _MSG_KIND_BY_CLASS = { 'msg-in': 'in', 'msg-out': 'out', 'msg-name': 'name', 'msg-meta': 'meta' };
const _CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function _msgLineKind(attrs) {
  const m = attrs.match(_CLASS_ATTR_RE);
  const cls = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  for (const c of cls.split(/\s+/)) if (_MSG_KIND_BY_CLASS[c]) return _MSG_KIND_BY_CLASS[c];
  return 'in';
}

// Zeilentext mit Satzzeichen an ihrem Platz (`bist du <em>da</em>?` → `bist du
// da?`), wie der KI-Pfad ihn sieht — die Zeilen gehen als Zitat an Modelle
// (Alters-Analyse) und in die Wortschatz-Segmente.
function _msgLineText(body) {
  return _decodeEntities(stripTagsKeepPunctuation(body)).replace(/\s+/g, ' ').trim();
}

// Leer wie im Editor (public/js/messages/msg-html.js#isEmptyMsgLine): kein Text
// und kein eingebetteter Inhalt.
const _MSG_LINE_CONTENT_RE = /<(?:img|hr|input|iframe|object|embed|video|audio|svg|canvas)\b/i;
function _isEmptyMsgBody(body) {
  return !htmlToPlainText(body) && !_MSG_LINE_CONTENT_RE.test(body);
}

// Zeilenarten und Absender-Seiten eines Verlaufs. Die Seite rechnet ueber ALLE
// Zeilen, auch leere — wie der Bildschirm (`.msg-name:has(+ p.msg-out)` sieht
// die leere Zeile als Nachbarn). Erst danach fallen leere Zeilen weg.
function _msgThreadRows(inner) {
  const rows = [];
  inner.replace(_MSG_LINE_RE, (p, attrs, body) => { rows.push({ p, attrs, body, kind: _msgLineKind(attrs) }); return ''; });
  const sides = msgNameSides(rows.map(r => r.kind));
  rows.forEach((r, i) => { r.side = sides[i]; });
  return rows;
}

/** Zeilen jedes Verlaufs: `[[{ kind: 'in'|'out'|'name'|'meta', text, side? }]]`,
 *  ein Array pro Verlauf, leere Zeilen fallen weg. Absenderzeilen tragen ihre
 *  Seite (`side`, ueber alle Zeilen gerechnet, siehe `_msgThreadRows`). Fuer
 *  Auswertungen, die den Absender brauchen (Figuren-Idiolekt,
 *  lib/lexicon/idiolect.js; Buch-Chat `get_dialogue`). */
function msgThreadLines(html) {
  return findMsgThreads(html).map(({ innerStart, innerEnd }) => {
    const lines = [];
    for (const r of _msgThreadRows(String(html).slice(innerStart, innerEnd))) {
      const text = _msgLineText(r.body);
      if (!text) continue;
      lines.push(r.kind === 'name' ? { kind: r.kind, text, side: r.side } : { kind: r.kind, text });
    }
    return lines;
  });
}

/** Nachrichten eines Verlaufs (aus `msgThreadLines`) → Aeusserungen
 *  `{ sender, text }`. `sender` ist der Text der geltenden Absenderzeile ihrer
 *  Seite (lib/msg-lines.js#msgNameSides) — sie gilt bis zur naechsten Absender-
 *  zeile derselben Seite im selben Verlauf, auch ueber Nachrichten der anderen
 *  Seite hinweg (ein Name oben reicht im Zwiegespraech). Das gilt fuer beide
 *  Seiten: ein Name ueber ausgehenden Nachrichten macht sie zu seinen. Ohne
 *  Absenderzeile ihrer Seite bleibt eine Nachricht ohne Absender.
 *  Die Seite eines Absenders kommt aus `side` (msgThreadLines, ueber alle Zeilen
 *  gerechnet); fehlt sie, aus der uebergebenen Folge.
 *  Konsumenten: Figuren-Idiolekt (lib/lexicon/idiolect.js), Alters-Scan
 *  (lib/figure-age/scan.js#scanMsgUtterances), Buch-Chat `get_dialogue`. */
function msgUtterances(threads) {
  const out = [];
  for (const lines of threads || []) {
    const sides = msgNameSides(lines.map(l => l.kind));
    const sender = { in: null, out: null };
    lines.forEach((l, i) => {
      if (l.kind === 'name') sender[l.side || sides[i]] = l.text;
      else if (l.kind === 'in' || l.kind === 'out') out.push({ sender: sender[l.kind], text: l.text });
    });
  }
  return out;
}

/** Absenderzeilen auf der ausgehenden Seite mit der Export-Klasse
 *  `msg-name-out` markieren (lib/msg-lines.js#msgNameSides) und leere Zeilen
 *  entfernen. Nur fuer Ausgabewege, die das Markup mit eigenem Stylesheet setzen
 *  (EPUB, HTML-Export): E-Reader kennen `:has()` nicht, mit dem der Bildschirm
 *  die Seite ableitet. Die Seite rechnet ueber alle Zeilen wie der Bildschirm;
 *  die leeren fallen danach, weil der Bildschirm sie als flache Blase ohne
 *  Text zeigt, ein E-Reader aber als leere Sprechblase. Nicht persistiert —
 *  die Seite steht im gespeicherten Markup nirgends, sie folgt der Nachricht
 *  darunter. */
function markMsgNameSides(html) {
  return replaceMsgThreads(html, (_thread, inner, openTag, closeTag) => {
    const rows = _msgThreadRows(inner);
    let i = 0;
    const marked = inner.replace(_MSG_LINE_RE, (p) => {
      const r = rows[i++];
      if (_isEmptyMsgBody(r.body)) return '';
      if (r.side !== 'out') return p;
      return p.replace(/^<p\b([^>]*)>/i, (_t, attrs) => {
        if (!_CLASS_ATTR_RE.test(attrs)) return `<p${attrs} class="msg-name-out">`;
        return `<p${attrs.replace(_CLASS_ATTR_RE, (_m, d, sq, bare) => `class="${d ?? sq ?? bare} msg-name-out"`)}>`;
      });
    });
    return openTag + marked + closeTag;
  });
}

/** Verlaeufe aus HTML entfernen (Block → ein Space). Fuer die satzbasierten
 *  Stil-Metriken: eine Chat-Zeile ist kein Satz der Erzaehlung — ohne Satzzeichen
 *  klebte sie an den Nachbarsatz („Sie wartete. bist du da gleich 5 min ok Dann
 *  kam er." = ein Satz mit 15 Woertern). Dieselbe Entscheidung wie bei Tabellen. */
function stripMsgThreads(html) {
  return replaceMsgThreads(html, () => ' ');
}

/** Plain-Text wie `htmlToPlainText` (zeichengleich) plus die Bereiche der
 *  Nachrichten eines Verlaufs darin: `{ text, msgRanges: [[start, end]],
 *  msgSenders: [string|null] }` — `msgSenders[i]` ist der Absender der Nachricht
 *  `msgRanges[i]` nach derselben Regel wie `msgUtterances` (null = ohne
 *  Absenderzeile ihrer Seite). Konsument: Buch-Chat `get_dialogue`.
 *
 *  Warum: Nachrichten sind Figurenrede, tragen aber keine Anfuehrungszeichen —
 *  die Dialog-Erkennung (lib/page-index.js#findDialogRanges) sieht sie im
 *  Plain-Text sonst als Erzaehltext. Absender- und Zeitzeilen sind keine Rede;
 *  ein `<p>` ohne Zeilenklasse gilt wie im Editor als eingehende Nachricht.
 *
 *  Mechanik: das HTML wird in Stuecke zerlegt, zwischen denen Marken als eigene
 *  Werte (nicht als Zeichen) stehen — die Endmarke ist ein `{ sender }`-Objekt; jedes Stueck laeuft durch denselben
 *  Tag-Strip und Entity-Decode, der Whitespace-Collapse von Hand. Keine
 *  Sentinel-Zeichen im Text: ein `&#xE001;` oder ein rohes Private-Use-Zeichen
 *  im Abschnitt bleibt Text wie in `htmlToPlainText`. */
const _MSG_OPEN = Symbol('msgOpen');

function htmlToPlainTextWithMsgRanges(html) {
  const src = stripDiagramBlocks(html);
  const parts = [];
  let last = 0;
  for (const th of findMsgThreads(src)) {
    const lineRe = new RegExp(_MSG_LINE_RE.source, 'gi');
    const inner = src.slice(th.innerStart, th.innerEnd);
    const rows = _msgThreadRows(inner);
    const sender = { in: null, out: null };
    let m;
    for (let i = 0; (m = lineRe.exec(inner)); i++) {
      const { kind, side } = rows[i];
      if (kind === 'name') {
        const name = _msgLineText(m[2]);
        if (name) sender[side] = name;
      }
      if (kind !== 'in' && kind !== 'out') continue;
      const bodyStart = th.innerStart + m.index + m[0].indexOf('>') + 1;
      const bodyEnd = bodyStart + m[2].length;
      parts.push(src.slice(last, bodyStart), _MSG_OPEN, src.slice(bodyStart, bodyEnd), { sender: sender[kind] });
      last = bodyEnd;
    }
  }
  parts.push(src.slice(last));

  let text = '';
  let pendingSpace = false;
  let openPending = false;
  let start = -1;
  const msgRanges = [];
  const msgSenders = [];
  for (const part of parts) {
    if (part === _MSG_OPEN) { openPending = true; start = -1; continue; }
    if (typeof part !== 'string') { // Endmarke einer Nachricht, traegt ihren Absender
      if (start >= 0) { msgRanges.push([start, text.length]); msgSenders.push(part.sender); }
      openPending = false; start = -1;
      continue;
    }
    for (const ch of _decodeEntities(part.replace(/<[^>]+>/g, ' '))) {
      if (/\s/.test(ch)) { pendingSpace = true; continue; }
      if (pendingSpace && text.length) text += ' ';
      pendingSpace = false;
      if (openPending) { start = text.length; openPending = false; }
      text += ch;
    }
  }
  return { text, msgRanges, msgSenders };
}

// Wortzahl eines Seiten-HTML — dieselbe Normalisierung wie page_stats.words
// (routes/sync.js#computeStats). Auch der Lektorat-Job stempelt damit die
// Wortzahl des geprüften Stands an page_checks.words, damit die Fehlerdichte
// gegen den Text rechnet, den der Lauf gesehen hat.
function pageWordCount(html) {
  const text = htmlToPlainText(html || '').trim();
  return text === '' ? 0 : text.split(/\s+/).length;
}

module.exports = { pageWordCount, htmlToPlainText, htmlToPlainTextWithMsgRanges, msgThreadLines, msgUtterances, markMsgNameSides, stripMsgThreads, stripDiagramBlocks, stripTableBlocks, stripTagsKeepPunctuation, TAG_GAP_CLASSES, summarizeTableBlocks, markMsgThreads, hasMsgThread, findMsgThreads, replaceMsgThreads, MSG_THREAD_MARKS, decodeEntities: _decodeEntities };

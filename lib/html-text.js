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
// Klammer, «, „): an ihnen darf die Tag-Grenze kein Space sein. Zwischen zwei
// Wortzeichen bleibt sie Space — das ist die harmlosere Annahme, und ein
// Block-/Inline-Mix (`<p>Wort</p><li>…`) darf daran nicht zusammenkleben.
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
const _TAG_MARK = '\u0000';
// Zeichen, die sich nach LINKS binden: davor erzeugt eine Tag-Grenze kein Space.
const _NO_SPACE_BEFORE_TAG = /[.,;:!?%…»›“”‘’)\]}]/;
// Zeichen, die sich nach RECHTS binden: dahinter ebenfalls kein Space.
const _NO_SPACE_AFTER_TAG = /[([{«‹„‚]/;

/** HTML → Text, in dem jede Tag-Grenze eine Wortgrenze ist — ausser an
 *  Satzzeichen, wo der Editor keinen Leerraum rendert. Siehe den Kommentar
 *  ueber den Zeichen-Klassen. */
function stripTagsKeepPunctuation(html) {
  const marked = String(html || '').replace(/<[^>]+>/g, _TAG_MARK);
  if (!marked.includes(_TAG_MARK)) return marked;
  return marked.replace(/\u0000/g, (_m, i) => {
    // Nachbarzeichen ueber einen Lauf benachbarter Tags hinweg suchen: der
    // Lauf entscheidet einstimmig, sonst entstuende zwischen zwei Tags ein
    // Space, den die Nachbarn nicht wollen.
    let a = i - 1;
    while (a >= 0 && marked[a] === _TAG_MARK) a--;
    let b = i + 1;
    while (b < marked.length && marked[b] === _TAG_MARK) b++;
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
const _MSG_THREAD_RE = /<div\b[^>]*\bclass="[^"]*\bmsg-thread\b[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/gi;

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

function markMsgThreads(html, { langCode = 'de', rows = false } = {}) {
  const marks = MSG_THREAD_MARKS[langCode] ? langCode : 'de';
  const { end } = MSG_THREAD_MARKS[marks];
  const label = rows ? MSG_THREAD_ROW_LABELS[marks] : MSG_THREAD_MARKS[marks].label;
  return String(html || '').replace(_MSG_THREAD_RE,
    (_m, inner) => `<p>[${label}]</p>${rows ? _msgRowsToText(inner) : inner}<p>[${end}]</p>`);
}

function hasMsgThread(html) {
  _MSG_THREAD_RE.lastIndex = 0;
  const hit = _MSG_THREAD_RE.test(String(html || ''));
  _MSG_THREAD_RE.lastIndex = 0;
  return hit;
}

function htmlToPlainText(html) {
  return _decodeEntities(stripDiagramBlocks(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain-Text wie `htmlToPlainText` (zeichengleich) plus die Bereiche der
 *  Nachrichten eines Verlaufs darin: `{ text, msgRanges: [[start, end]] }`.
 *
 *  Warum: Nachrichten sind Figurenrede, tragen aber keine Anfuehrungszeichen —
 *  die Dialog-Erkennung (lib/page-index.js#findDialogRanges) sieht sie im
 *  Plain-Text sonst als Erzaehltext. Absender- und Zeitzeilen sind keine Rede;
 *  ein `<p>` ohne Zeilenklasse gilt wie im Editor als eingehende Nachricht.
 *
 *  Mechanik: Private-Use-Marken um jede Nachricht, dann derselbe Tag-Strip und
 *  Entity-Decode; der Whitespace-Collapse laeuft von Hand, damit die Marken
 *  breitenlos herausfallen und der Text exakt dem von `htmlToPlainText` gleicht. */
const _MSG_OPEN = '\uE000';
const _MSG_CLOSE = '\uE001';
const _MSG_LINE_RE = /<p\b([^>]*)>([\s\S]*?)<\/p\s*>/gi;
// Zeilenart aus der Klasse; ohne Zeilenklasse eingehend (wie im Editor).
const _MSG_KIND_BY_CLASS = { 'msg-in': 'in', 'msg-out': 'out', 'msg-name': 'name', 'msg-meta': 'meta' };

function _msgLineKind(attrs) {
  const m = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
  for (const c of (m ? m[1].split(/\s+/) : [])) if (_MSG_KIND_BY_CLASS[c]) return _MSG_KIND_BY_CLASS[c];
  return 'in';
}

function _isMsgSpeechLine(attrs) {
  const kind = _msgLineKind(attrs);
  return kind === 'in' || kind === 'out';
}

/** Zeilen jedes Verlaufs: `[[{ kind: 'in'|'out'|'name'|'meta', text }]]`,
 *  ein Array pro Verlauf, leere Zeilen fallen weg. Fuer Auswertungen, die den
 *  Absender brauchen (Figuren-Idiolekt, lib/lexicon/idiolect.js). */
function msgThreadLines(html) {
  const threads = [];
  String(html || '').replace(_MSG_THREAD_RE, (_m, inner) => {
    const lines = [];
    inner.replace(_MSG_LINE_RE, (_p, attrs, body) => {
      const text = htmlToPlainText(body);
      if (text) lines.push({ kind: _msgLineKind(attrs), text });
      return '';
    });
    threads.push(lines);
    return '';
  });
  return threads;
}

/** Nachrichten eines Verlaufs (aus `msgThreadLines`) → Aeusserungen
 *  `{ sender, text }`. `sender` ist der Text der geltenden Absenderzeile ihrer
 *  Seite (lib/msg-lines.js#msgNameSides) — sie gilt bis zur naechsten Absender-
 *  zeile derselben Seite im selben Verlauf, auch ueber Nachrichten der anderen
 *  Seite hinweg (ein Name oben reicht im Zwiegespraech). Ohne Absenderzeile
 *  ihrer Seite bleibt eine Nachricht ohne Absender — bei ausgehenden der
 *  Regelfall: wem das Telefon gehoert, steht nur da, wo der Autor es schreibt.
 *  Konsumenten: Figuren-Idiolekt (lib/lexicon/idiolect.js), Alters-Scan
 *  (lib/figure-age/scan.js#scanMsgUtterances). */
function msgUtterances(threads) {
  const out = [];
  for (const lines of threads || []) {
    const sides = msgNameSides(lines.map(l => l.kind));
    const sender = { in: null, out: null };
    lines.forEach((l, i) => {
      if (l.kind === 'name') sender[sides[i]] = l.text;
      else if (l.kind === 'in' || l.kind === 'out') out.push({ sender: sender[l.kind], text: l.text });
    });
  }
  return out;
}

/** Absenderzeilen auf der ausgehenden Seite mit der Export-Klasse
 *  `msg-name-out` markieren (lib/msg-lines.js#msgNameSides). Nur fuer
 *  Ausgabewege, die das Markup mit eigenem Stylesheet setzen (EPUB,
 *  HTML-Export): E-Reader kennen `:has()` nicht, mit dem der Bildschirm die
 *  Seite ableitet. Nicht persistiert — die Seite steht im gespeicherten
 *  Markup nirgends, sie folgt der Nachricht darunter. */
function markMsgNameSides(html) {
  return String(html || '').replace(_MSG_THREAD_RE, (thread, inner) => {
    const kinds = [];
    inner.replace(_MSG_LINE_RE, (_p, attrs, body) => {
      if (htmlToPlainText(body)) kinds.push(_msgLineKind(attrs));
      return '';
    });
    const sides = msgNameSides(kinds);
    let i = 0;
    const marked = inner.replace(_MSG_LINE_RE, (p, attrs, body) => {
      if (!htmlToPlainText(body)) return p;
      const side = sides[i++];
      if (side !== 'out') return p;
      return p.replace(/\bclass\s*=\s*"([^"]*)"/i, (_m, c) => `class="${c} msg-name-out"`);
    });
    return thread.replace(inner, () => marked);
  });
}

/** Verlaeufe aus HTML entfernen (Block → ein Space). Fuer die satzbasierten
 *  Stil-Metriken: eine Chat-Zeile ist kein Satz der Erzaehlung — ohne Satzzeichen
 *  klebte sie an den Nachbarsatz („Sie wartete. bist du da gleich 5 min ok Dann
 *  kam er." = ein Satz mit 15 Woertern). Dieselbe Entscheidung wie bei Tabellen. */
function stripMsgThreads(html) {
  return String(html || '').replace(_MSG_THREAD_RE, ' ');
}

function htmlToPlainTextWithMsgRanges(html) {
  const src = String(html || '').replace(/[\uE000\uE001]/g, '');
  const marked = src.replace(_MSG_THREAD_RE, (_m, inner) => '<div>' + inner.replace(_MSG_LINE_RE,
    (p, attrs, body) => (_isMsgSpeechLine(attrs) ? `<p${attrs}>${_MSG_OPEN}${body}${_MSG_CLOSE}</p>` : p)) + '</div>');
  const raw = _decodeEntities(stripDiagramBlocks(marked).replace(/<[^>]+>/g, ' '));

  let text = '';
  let pendingSpace = false;
  let openPending = false;
  let start = -1;
  const msgRanges = [];
  for (const ch of raw) {
    if (ch === _MSG_OPEN) { openPending = true; start = -1; continue; }
    if (ch === _MSG_CLOSE) {
      if (start >= 0) msgRanges.push([start, text.length]);
      openPending = false; start = -1;
      continue;
    }
    if (/\s/.test(ch)) { pendingSpace = true; continue; }
    if (pendingSpace && text.length) text += ' ';
    pendingSpace = false;
    if (openPending) { start = text.length; openPending = false; }
    text += ch;
  }
  return { text, msgRanges };
}

module.exports = { htmlToPlainText, htmlToPlainTextWithMsgRanges, msgThreadLines, msgUtterances, markMsgNameSides, stripMsgThreads, stripDiagramBlocks, stripTableBlocks, stripTagsKeepPunctuation, summarizeTableBlocks, markMsgThreads, hasMsgThread, MSG_THREAD_MARKS, decodeEntities: _decodeEntities };

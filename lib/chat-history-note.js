'use strict';
// Maschinelle Verlaufs-Anhänge des Chats: Format und Echo-Entfernung.
//
// Der Server hängt an früheren Antworten Notizen an: die validierten Belege
// (Buch-Chat) und die Vorschlags-/Ideen-Listen mit Status (Abschnitts-Chat). Ohne
// sie kennt das Modell bei einer Folgefrage nur die eigene Prosa — nicht die
// Stellen, auf die sich die Antwort stützte, und nicht den Status der Vorschläge.
//
// Die Notiz ist eine Notiz des Systems, KEIN Antworttext. Sie hängt am
// Assistant-Turn, das Modell liest sie als eigenen Text — und hat sie in der
// nächsten Antwort mitgeschrieben (Buch-Chat: eigener Beleg-Absatz am Fuss der
// Antwort, obwohl das System die Belege ohnehin als Liste unter der Antwort zeigt).
// Daraus folgen zwei Regeln:
//   1. Die Notiz ist als Verlaufs-Notiz markiert («nicht in der Antwort
//      wiedergeben»), damit das Modell sie nicht als Antwortformat übernimmt.
//   2. Ein Echo wird an jedem Weg entfernt, der den Antworttext benutzt: beim
//      Speichern (Job), beim Lesen (Chat-API) und im Modellverlauf.
//
// Format und Echo-Entfernung stehen zusammen hier, damit sie nicht auseinanderlaufen:
// der Strip erkennt die Notizen an ihren Markern (NOTE_MARKERS), und dieselben
// Konstanten bauen die Formate. Die Inhalte selbst (Belege, Vorschläge, Ideen)
// bleiben, wo sie hingehören: die Belege im Buch-Chat (context_info.citations), die
// Vorschläge in der Spalte `vorschlaege`, die Ideen in context_info.proposals.
//
// Die Belege des Buch-Chats stehen ausserhalb der Antwort (context_info.citations →
// Liste unter der Antwort), die Vorschläge des Abschnitts-Chats ebenfalls (Spalte
// `vorschlaege` → Liste unter der Antwort).

// Marker der maschinellen Verlaufs-Anhänge. Sie stehen am Anfang der Notiz und
// erkennen sie — auch in älteren Antworten, die noch die frühere Form tragen.
const NOTE_MARKERS = {
  citation:   '[Belege',                    // Buch-Chat: geprüfte Belege
  vorschlaege: '[Deine Änderungsvorschläge', // Abschnitts-Chat: Vorschläge mit Status
  ideen:      '[Deine Ideen-Vorschläge',      // Abschnitts-Chat: Ideen mit Status
};
const MARKER_LIST = Object.values(NOTE_MARKERS);

// Echo des Hinweises in einer Antwort: ein oder mehrere Blöcke am Ende, je in
// der Form, die die Formatierer unten erzeugen — einzeilig beim Buch-Chat
// («[Belege … ]» auf einer Zeile), mehrzeilig beim Abschnitts-Chat (Kopfzeile
// mit «:», nummerierte Zeilen, «]» allein auf der letzten Zeile). Der Block
// muss am Zeilenanfang stehen — ein «[Belege]» mitten im Fliesstext ist normales
// Zitat und bleibt stehen. Kein «[\s\S]*» über Zeilen: das reichte vom ersten
// «[Belege …» bis zur letzten «]» der Antwort und löschte den Text dazwischen.
const _ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const _NOTE_HEAD = `\\[(?:${MARKER_LIST.map(m => _ESC(m.slice(1))).join('|')}) `;
const _NOTE_BLOCK = `[ \\t]*${_NOTE_HEAD}(?:[^\\n]*\\]|[^\\n]*:(?:\\n[ \\t]*\\d+\\.[^\\n]*)*\\n[ \\t]*\\])[ \\t]*`;
const NOTE_ECHO_RE = new RegExp(`(?:^|\\n)${_NOTE_BLOCK}(?:\\s*\\n${_NOTE_BLOCK})*\\s*$`);

// Höchstzahl und Höchstlänge der Belege im Verlauf: der Verlauf soll nicht wachsen.
const HISTORY_CITATIONS_MAX = 6;
const HISTORY_CITATION_QUOTE_MAX = 160;
// Höchstlänge der Zitate im Vorschlags-/Ideen-Anhang.
const NOTE_CLIP = 160;

function _clip(s, n = NOTE_CLIP) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Verlaufs-Hinweis zu den gültigen Belegen einer früheren Antwort (Buch-Chat).
 * @param {Array<{n?:number, page_id?:number|null, page_name?:string|null, quote?:string, valid?:boolean}>} citations
 * @returns {string} leer, wenn keine gültigen Belege vorhanden sind
 */
function formatCitationNote(citations) {
  const cites = (Array.isArray(citations) ? citations : []).filter(c => c && c.valid && c.quote);
  if (!cites.length) return '';
  const lines = cites.slice(0, HISTORY_CITATIONS_MAX).map((c) => {
    const q = String(c.quote);
    const quote = q.length > HISTORY_CITATION_QUOTE_MAX ? q.slice(0, HISTORY_CITATION_QUOTE_MAX) + '…' : q;
    const where = c.page_id ? `Abschnitt «${c.page_name || '?'}» (page_id ${c.page_id})` : 'Abschnitt unbekannt';
    return `(${c.n}) ${where}: «${quote}»`;
  });
  return `${NOTE_MARKERS.citation} der vorigen Antwort (Verlauf — nicht in der Antwort wiedergeben): ${lines.join(' ')}]`;
}

/**
 * Frühere Vorschläge einer Antwort mit ihrem Status (Abschnitts-Chat). Ohne diesen
 * Anhang sieht das Modell nur seinen Antworttext: es schlägt übernommene Stellen
 * erneut vor (die es so nicht mehr gibt) und weiss nicht, was der Autor verworfen hat.
 * @param {Array<{original?:string, ersatz?:string, applied?:boolean, status?:string, match?:string}>} vorschlaege
 * @returns {string} leer, wenn keine Vorschläge vorhanden sind
 */
function formatProposalNote(vorschlaege) {
  if (!Array.isArray(vorschlaege) || vorschlaege.length === 0) return '';
  const lines = vorschlaege.map((v, i) => {
    const status = v?.applied ? 'übernommen'
      : v?.status === 'discarded' ? 'verworfen'
      : v?.match === 'not_found' ? 'offen, Stelle nicht im Text gefunden'
      : 'offen';
    return `${i + 1}. [${status}] «${_clip(v?.original)}» → «${_clip(v?.ersatz)}»`;
  });
  return [`${NOTE_MARKERS.vorschlaege} in dieser Antwort, Status beim Autor (Verlauf — nicht in der Antwort wiedergeben):`, ...lines, ']'].join('\n');
}

/**
 * Frühere Ideen-Vorschläge einer Antwort mit ihrem Status (Abschnitts-Chat) — sonst
 * schlägt das Modell verworfene erneut vor. Erfasste stehen zusätzlich als OFFENE
 * IDEEN im Prompt, solange sie offen sind.
 * @param {Array<{type?:string, fields?:{content?:string}, applied_at?:string, status?:string}>} proposals
 * @returns {string} leer, wenn keine Ideen vorhanden sind
 */
function formatIdeenNote(proposals) {
  const list = Array.isArray(proposals) ? proposals.filter(p => p?.type === 'idee_create') : [];
  if (list.length === 0) return '';
  const lines = list.map((p, i) => {
    const status = p.applied_at ? 'als Idee erfasst' : p.status === 'discarded' ? 'verworfen' : 'offen';
    return `${i + 1}. [${status}] ${_clip(p.fields?.content)}`;
  });
  return [`${NOTE_MARKERS.ideen} in dieser Antwort, Status beim Autor (Verlauf — nicht in der Antwort wiedergeben):`, ...lines, ']'].join('\n');
}

/**
 * Echo eines Verlaufs-Anhangs aus einem Antworttext entfernen (steht am Ende der
 * Antwort). Ein reiner Text ohne Echo bleibt unverändert.
 * @param {string} text
 * @returns {string} der bereinigte Text
 */
function stripHistoryNote(text) {
  if (typeof text !== 'string') return text;
  if (!MARKER_LIST.some(m => text.includes(m))) return text;
  return text.replace(NOTE_ECHO_RE, '').trimEnd();
}

module.exports = {
  formatCitationNote, formatProposalNote, formatIdeenNote, stripHistoryNote,
  NOTE_MARKERS, HISTORY_CITATIONS_MAX, HISTORY_CITATION_QUOTE_MAX,
};

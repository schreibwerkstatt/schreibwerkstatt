'use strict';
// Verlauf und Antwort-Normalisierung des agentischen Chat-Loops (./loop.js):
// Rolling-Window-Historie mit Belegen, i18n-Marker für Antworten ohne Inhalt,
// Prosa-Abschluss.

const { buildChatMessageHistory } = require('../shared');

// Modell-Drift: schreibt Prosa-Antwort und hängt am Ende ```json\n{}\n``` als
// Compliance-Theater an. extractBalancedJson greift dann das leere {} → antwort
// fehlt. Trailing-Fence vor Speicherung entfernen.
function stripTrailingEmptyJson(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*```(?:json)?\s*\{\s*\}\s*```\s*$/i, '')
    .replace(/\s*\{\s*\}\s*$/, '')
    .trim();
}

// Gespeicherte Fallback-Antworten (`__i18n:chat.errors.…__`) sind für das Frontend
// bestimmt, nicht für das Modell: roh im Verlauf hält es den Marker für Gesprächstext
// und ahmt ihn im Zweifel nach. Ersetzt wird nur die Antwort, die Frage davor bleibt —
// so bleibt die Rollen-Alternanz intakt, und das Modell sieht, dass die Frage offen ist.
const I18N_MARKER_RE = /__i18n:[a-zA-Z0-9_.-]+__/g;
const FALLBACK_PLACEHOLDER = '[Keine inhaltliche Antwort: der Lauf zu dieser Frage endete ohne verwertbares Ergebnis.]';
function _neutralizeMarkers(content) {
  return typeof content === 'string' ? content.replace(I18N_MARKER_RE, FALLBACK_PLACEHOLDER) : content;
}

// Belege früherer Antworten (context_info.citations, nur gültige) kompakt an den
// Assistant-Turn im Verlauf hängen: ohne sie kennt das Modell bei einer Folgefrage
// («und was sagt sie danach?») nur die eigene Prosa, nicht mehr die Stellen, auf die
// sie sich stützte — und sucht sie neu. Gedeckelt, der Verlauf soll nicht wachsen.
const HISTORY_CITATIONS_MAX = 6;
const HISTORY_CITATION_QUOTE_MAX = 160;
function _citationNote(row) {
  if (row.role !== 'assistant' || !row.context_info) return '';
  let ci;
  try { ci = JSON.parse(row.context_info); } catch { return ''; }
  const cites = Array.isArray(ci?.citations) ? ci.citations.filter(c => c && c.valid && c.quote) : [];
  if (!cites.length) return '';
  const lines = cites.slice(0, HISTORY_CITATIONS_MAX).map((c) => {
    const q = String(c.quote);
    const quote = q.length > HISTORY_CITATION_QUOTE_MAX ? q.slice(0, HISTORY_CITATION_QUOTE_MAX) + '…' : q;
    const where = c.page_id ? `Abschnitt «${c.page_name || '?'}» (page_id ${c.page_id})` : 'Abschnitt unbekannt';
    return `(${c.n}) ${where}: «${quote}»`;
  });
  return `[Belege dieser Antwort: ${lines.join(' ')}]`;
}

// Rolling-Window: erste user+assistant-Runde als Kontext-Anker + die letzten
// tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
// Rollen strikt alternierend, Beginn mit user: ein Tail, der mit einer Antwort
// beginnt, stünde sonst direkt hinter der Anker-Antwort (zwei Assistant-Turns in
// Folge — Anthropic verschmilzt sie stumm, strikte Chat-Vorlagen lokaler Modelle
// werfen). Führende Antworten des Tails fallen darum weg.
function buildAgenticHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId, { annotate: _citationNote })
    .map(m => (m.role === 'assistant' ? { ...m, content: _neutralizeMarkers(m.content) } : m));
  while (all.length && all[0].role !== 'user') all.shift();
  if (all.length <= tailMessages + 2) return all;
  const anchor = all[1]?.role === 'assistant' ? [all[0], all[1]] : [all[0]];
  const tail = all.slice(-tailMessages);
  while (tail.length && tail[0].role === 'assistant') tail.shift();
  return [...anchor, ...tail];
}

// Leere Antwort (final_answer mit antwort:"" oder Prosa ohne Text) nie roh speichern:
// _parseChatResponse fiele sonst auf den Rohtext zurück, und im Chat stünde
// `{"antwort":""}`. Stattdessen ein i18n-Marker, den das Frontend auflöst.
const EMPTY_ANSWER_MARKER = '__i18n:chat.errors.emptyAnswer__';
// Ablehnung durch einen Sicherheits-Klassifikator (stop_reason `refusal`): eigener
// Hinweis statt «leere Antwort» — der User soll wissen, dass die Frage abgelehnt und
// nicht etwa vergessen wurde. Teilweise gestreamter Text wird verworfen.
const REFUSAL_MARKER = '__i18n:chat.errors.refusal__';
function _ensureNonEmptyFinal(finalText) {
  if (typeof finalText !== 'string' || !finalText.trim()) return JSON.stringify({ antwort: EMPTY_ANSWER_MARKER });
  const t = finalText.trim();
  if (!t.startsWith('{')) return finalText;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && 'antwort' in obj && !String(obj.antwort ?? '').trim()) {
      return JSON.stringify({ ...obj, antwort: EMPTY_ANSWER_MARKER });
    }
  } catch { /* kein JSON → Parser des Chats entscheidet */ }
  return finalText;
}

// Prosa-Abschluss (Modell beendet ohne final_answer): Prosa IST die Antwort.
function _proseFinal(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  return raw.startsWith('{') ? raw : JSON.stringify({ antwort: stripTrailingEmptyJson(raw) || raw });
}

module.exports = {
  stripTrailingEmptyJson, buildAgenticHistory, EMPTY_ANSWER_MARKER, REFUSAL_MARKER, FALLBACK_PLACEHOLDER,
  _ensureNonEmptyFinal, _proseFinal,
};

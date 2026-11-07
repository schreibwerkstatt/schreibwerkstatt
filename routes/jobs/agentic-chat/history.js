'use strict';
// Verlauf und Antwort-Normalisierung des agentischen Chat-Loops (./loop.js):
// Rolling-Window-Historie mit Belegen, i18n-Marker für Antworten ohne Inhalt,
// Prosa-Abschluss.

const { buildChatMessageHistory } = require('../shared');
const { formatCitationNote, formatSourceNote, stripHistoryNote } = require('../../../lib/chat-history-note');

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

// Beleg-Echo aus einer gespeicherten Antwort entfernen (lib/chat-history-note.js).
// Läuft VOR dem Anhängen des Verlaufs-Hinweises: das Modell hat den Hinweis als
// eigenen Text gelesen und in der nächsten Antwort mitgeschrieben — im Verlauf würde
// es das Muster wiederholen. Der Hinweis selbst ist kein Echo und bleibt stehen.
function _stripEcho(row) {
  if (row.role !== 'assistant') return row.content;
  const text = stripHistoryNote(row.content);
  return _ciOf(row)?.mode === 'research' ? _stripResearchCites(text) : text;
}

function _ciOf(row) {
  if (!row.context_info) return null;
  try { return JSON.parse(row.context_info); } catch { return null; }
}

// Belegmarker einer Recherche-Antwort (`<cite index="N-…">TEXT</cite>` der
// Anthropic-Suche, `[N]` des Suchwegs SearXNG) zeigen auf die Treffer IHRES Laufs.
// Im Verlauf eines neuen Laufs zeigten dieselben Nummern auf andere Treffer —
// das Modell kopierte sie und verlinkte falsch. Die Quellen selbst stehen in der
// Quellen-Notiz (formatSourceNote). Gleiche Muster wie das Frontend
// (public/js/chat/research-chat-render.js).
const CITE_TAG_RE = /<cite\b[^>]*>([\s\S]*?)<\/cite>/gi;
const BRACKET_CITE_RE = /[ \t]*\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;
function _stripResearchCites(text) {
  if (typeof text !== 'string') return text;
  if (/<cite\b/i.test(text)) return text.replace(CITE_TAG_RE, '$1').replace(/<\/?cite\b[^>]*>/gi, '');
  return text.replace(BRACKET_CITE_RE, '');
}

// Belege früherer Antworten (context_info.citations, nur gültige) kompakt an den
// Assistant-Turn im Verlauf hängen: ohne sie kennt das Modell bei einer Folgefrage
// («und was sagt sie danach?») nur die eigene Prosa, nicht mehr die Stellen, auf die
// sie sich stützte — und sucht sie neu. Gedeckelt, der Verlauf soll nicht wachsen.
// Format und Zweck: lib/chat-history-note.js.
// Recherche-Antworten: statt Buch-Belegen die geprüften Quellen (answer_sources).
function _citationNote(row) {
  if (row.role !== 'assistant') return '';
  const ci = _ciOf(row);
  if (!ci) return '';
  if (ci.mode === 'research') return formatSourceNote(ci.answer_sources);
  return formatCitationNote(ci.citations);
}

// Rolling-Window: erste user+assistant-Runde als Kontext-Anker + höchstens
// tailMessages der jüngsten Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
// Das Fenster rückt in Sprüngen vor, nicht mit jeder Frage: sein Anfang liegt auf
// einem Raster von `step` Nachrichten, der Tail ist darum zwischen
// tailMessages - step + 1 und tailMessages lang. Ein gleitendes Fenster änderte
// den Verlauf direkt hinter dem Anker bei jedem Turn — der Cache-Präfix
// (cacheHistory) würde dann jedes Mal ganz neu geschrieben statt gelesen.
// Rollen strikt alternierend, Beginn mit user: ein Tail, der mit einer Antwort
// beginnt, stünde sonst direkt hinter der Anker-Antwort (zwei Assistant-Turns in
// Folge — Anthropic verschmilzt sie stumm, strikte Chat-Vorlagen lokaler Modelle
// werfen). Führende Antworten des Tails fallen darum weg.
function buildAgenticHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId, { annotate: _citationNote, sanitize: _stripEcho })
    .map(m => (m.role === 'assistant' ? { ...m, content: _neutralizeMarkers(m.content) } : m));
  while (all.length && all[0].role !== 'user') all.shift();
  if (all.length <= tailMessages + 2) return all;
  const anchor = all[1]?.role === 'assistant' ? [all[0], all[1]] : [all[0]];
  const body = all.slice(anchor.length);
  // Gerades Raster: ein Fensteranfang auf einer Frage bleibt auf einer Frage.
  const step = 2 * Math.max(1, Math.ceil(tailMessages / 4));
  const minKeep = Math.max(1, tailMessages - step + 1);
  const start = Math.max(0, Math.floor((body.length - minKeep) / step) * step);
  const tail = body.slice(start);
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

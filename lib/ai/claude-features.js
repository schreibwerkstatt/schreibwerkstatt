'use strict';
// Claude-API-Fähigkeiten, die allein am Modellstring hängen und weder Settings noch
// Job-Kontext brauchen. Ausgelagert aus ./config.js (Datei-Limit); config.js
// re-exportiert sie, Aufrufer importieren weiter von dort.

// Web-Suche mit dynamischer Filterung (`web_search_20260209`): die API filtert die
// Treffer per Code-Ausführung vor, bevor sie in den Kontext gehen — weniger Input je
// Suche. Angeboten für Opus 4.6+, Sonnet 4.6+ und Fable/Mythos; ältere Modelle (und
// Haiku) behalten `web_search_20250305`. Die Antwort trägt dann zusätzlich ein Paar
// `server_tool_use` (code_execution) + `code_execution_tool_result`.
function _claudeSupportsDynamicWebSearch(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[6-9]|\d\d)/.test(m)
    || /claude-opus-(?:[5-9]|\d\d)/.test(m)
    || /claude-sonnet-4-(?:[6-9]|\d\d)/.test(m)
    || /claude-sonnet-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m);
}

// Werkzeuge mitten im Gespräch entfernen (`tool_removal`-Block in einer
// `role: 'system'`-Nachricht, Beta mid-conversation-tool-changes-2026-07-01), ohne
// den Werkzeug-Präfix im Cache zu ändern. Opus 4.8, Opus 5+, Fable/Mythos 5+,
// Sonnet 5.5+ und Haiku 5.5+ — ausdrücklich NICHT Sonnet 5.
function _claudeSupportsToolRemoval(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[89]|\d\d)/.test(m)
    || /claude-opus-(?:[5-9]|\d\d)/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m)
    || /claude-(?:sonnet|haiku)-5-(?:[5-9]|\d\d)/.test(m)
    || /claude-(?:sonnet|haiku)-(?:[6-9]|\d\d)\b/.test(m);
}

module.exports = { _claudeSupportsDynamicWebSearch, _claudeSupportsToolRemoval };

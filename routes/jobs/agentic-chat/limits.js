'use strict';
// Deckel der agentischen Chats (Buch, Plot, Ideen, Recherche) — eine Quelle,
// damit alle Chats gleich teuer und gleich sicher bleiben. Der Loop (./loop.js)
// liest die Werte aus prepare(); hier werden sie berechnet.

const appSettings = require('../../../lib/app-settings');
const { providerClass } = require('../../../lib/ai');

// Werkzeug-Aufrufe pro Runde. Die Prompts fordern gebündelte Aufrufe — ungedeckelt
// hängt eine einzige Runde mit vielen Volltexten aber mehr an, als das Fenster
// trägt, und erst der NÄCHSTE Call merkt es. Genug für breites Bündeln, nicht für
// einen Rundumschlag.
const MAX_TOOLS_PER_ROUND = 8;

/**
 * Iterations-Deckel eines Chats. Lokale Provider bekommen zusätzlich den
 * gemeinsamen Deckel `jobs.book_chat.max_tool_iter_local`: ohne Prompt-Caching
 * kostet jede Runde den vollen Prompt erneut, und eine Runde dauert dort Sekunden
 * bis Minuten. `..._local = 0` schaltet ihn ab.
 */
function maxToolIterFor(settingKey, fallback, provider, userEmail) {
  const base = parseInt(appSettings.get(settingKey), 10) || fallback;
  if (providerClass(provider, { userEmail }) !== 'local') return base;
  const local = parseInt(appSettings.get('jobs.book_chat.max_tool_iter_local'), 10) || 0;
  return local > 0 ? Math.min(base, local) : base;
}

/**
 * Deckel pro Werkzeug-Ergebnis: eine einzelne Antwort darf das Budget nicht allein
 * sprengen. Annahme: maxIter Runden × ~3 Aufrufe × Sicherheitsfaktor 2. Mindestens
 * 4000 Zeichen, damit Ergebnisse bei kleinen Kontextfenstern brauchbar bleiben.
 */
function toolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
}

/** Summe der Ergebnisse einer Runde: ein Viertel des Input-Budgets, mindestens zwei volle Einzelergebnisse. */
function roundResultCapChars(aiCfg, toolResultCap) {
  return Math.max(toolResultCap * 2, Math.floor((aiCfg.inputBudgetChars || 0) * 0.25));
}

/**
 * Kosten-Deckel pro Antwort: kumulierte Input-Tokens über alle Iterationen (inkl.
 * Cache-Lesen). Prompt-Caching macht eine Runde billig, aber nicht gratis — viele
 * Runden mit Kapitel-Volltexten summieren sich auf Millionen Tokens. Erreicht →
 * erzwungene Synthese, kein Hart-Abbruch. 0 = aus. Ein Setting für alle Chats.
 */
function inputTokenCapPerAnswer() {
  const v = parseInt(appSettings.get('jobs.book_chat.max_input_tokens_per_answer'), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Alle Deckel eines Laufs, fertig für prepare(). */
function agentLimits(maxIter, aiCfg) {
  const toolResultCap = toolResultCapChars(maxIter, aiCfg);
  return {
    toolResultCap,
    maxToolsPerRound: MAX_TOOLS_PER_ROUND,
    roundResultCapChars: roundResultCapChars(aiCfg, toolResultCap),
    inputTokenCap: inputTokenCapPerAnswer(),
  };
}

module.exports = {
  MAX_TOOLS_PER_ROUND, maxToolIterFor, toolResultCapChars, roundResultCapChars, inputTokenCapPerAnswer, agentLimits,
};

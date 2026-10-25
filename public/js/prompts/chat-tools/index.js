// Gemeinsamer Werkzeug-Katalog der agentischen Chats (Buch-, Plot-, Ideen-,
// Recherche-Chat): jede Lese-Definition steht genau einmal hier, ihr Handler
// genau einmal in routes/jobs/chat-tools/. Welcher Chat was bekommt, steht in
// ./access.js; die Ausgabe-Werkzeuge (final_answer, propose_*, Web-Suche) bringt
// jeder Chat selbst mit. Regeln für neue Werkzeuge: ./CLAUDE.md.
//
// Querverweise zwischen Werkzeugen stehen NIE im Fliesstext, sondern in `see`
// ({ zielwerkzeug: 'Satz mit `zielwerkzeug`.' }). renderChatTools hängt einen
// Satz nur an, wenn das Ziel im selben Lauf angeboten wird — so empfiehlt keine
// Beschreibung ein Werkzeug, das der Chat (Slim-Satz, fehlender Endpunkt, keine
// Daten im Buch) gar nicht hat.

import { TEXT_TOOLS } from './catalog-text.js';
import { WORLD_TOOLS } from './catalog-world.js';
import { ANALYSIS_TOOLS } from './catalog-analysis.js';
import { PLANNING_TOOLS } from './catalog-planning.js';
import { chatToolNames } from './access.js';

export const CHAT_TOOLS = [...TEXT_TOOLS, ...WORLD_TOOLS, ...ANALYSIS_TOOLS, ...PLANNING_TOOLS];

// Namen früherer Werkzeuge, die in gespeicherten Antworten (context_info.tool_calls)
// noch vorkommen. Kein Werkzeug darf einen davon wieder tragen; ihre i18n-Labels
// (chat.tool.<name>) bleiben für den Verlauf alter Antworten stehen.
export const RETIRED_CHAT_TOOL_NAMES = [
  'find_first_last_mention',   // → get_figure_mentions / list_locations
  'quote_match',               // → quote_passage (pattern)
  'get_werkstatt_draft',       // → list_werkstatt_drafts (draft_id)
  'get_motif_occurrences',     // → get_motifs (motif_id)
  'get_lektorat_hotspots',     // → get_lektorat (view=hotspots)
  'get_lektorat_findings',     // → get_lektorat (view=findings)
  'diff_page_revisions',       // → list_revisions (diff)
  'count_pronouns',            // → get_stil_metrics (pronouns)
];

const BY_NAME = new Map(CHAT_TOOLS.map(t => [t.name, t]));

/**
 * Definitionen fürs Modell: `see`-Sätze nur für Ziele, die in `defs` selbst
 * vorkommen, und `see` selbst fällt weg (kein Feld des Tool-Formats).
 * Definitionen ohne `see` (z.B. Anthropics serverseitiges web_search) bleiben
 * unverändert.
 * @param {Array<object>} defs  vollständige Werkzeugliste eines Laufs
 */
export function renderChatTools(defs) {
  const offered = new Set(defs.map(d => d.name));
  return defs.map(d => {
    if (!d.see) return d;
    const { see, ...rest } = d;
    const extra = Object.entries(see).filter(([name]) => offered.has(name)).map(([, s]) => s);
    return extra.length ? { ...rest, description: `${rest.description} ${extra.join(' ')}` } : rest;
  });
}

/**
 * Werkzeugliste eines Laufs: Lese-Werkzeuge des Chats (Katalog-Reihenfolge,
 * ohne `unavailable`) + die Ausgabe-Werkzeuge des Chats, gemeinsam gerendert.
 * @param {'book'|'plot'|'ideen'|'research'} chat
 * @param {{ slim?: boolean, unavailable?: Set<string>, outputTools?: Array<object> }} opts
 */
export function buildChatToolset(chat, { slim = false, unavailable = new Set(), outputTools = [] } = {}) {
  const read = chatToolNames(chat, { slim }).filter(n => !unavailable.has(n)).map(n => BY_NAME.get(n));
  return renderChatTools([...read, ...outputTools]);
}

export { CHAT_TOOL_ACCESS, CHAT_KINDS, chatToolNames } from './access.js';
export { toolMentions } from './mentions.js';
